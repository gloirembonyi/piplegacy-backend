import { buildGlobalMarketContext } from '@/lib/market-context-prompt'
import {
  getGeminiApiKeys,
  getGeminiChatModels,
} from '@/lib/gemini'
import { generateGeminiContent } from '@/lib/gemini-generate'
import { resolveTokenUsage } from '@/lib/ai-usage-tracker'
import { parseAnalysisJson } from '@/lib/parse-analysis-json'
import { isAuthSession, requireAuth } from '@/lib/require-auth'
import { addUserAnalysis, getUserData } from '@/lib/user-store'
import { consumePlanUsage, recordPlanTokens } from '@/lib/plan-usage'
import { isValidChartImagePayload } from '@/lib/validation'

function geminiErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    /* use generic */
  }
  if (status === 400) return 'Invalid request to Gemini. Try another image.'
  if (status === 403) return 'Ai API key is invalid or lacks access.'
  if (status === 429) return 'Ai rate limit reached. Wait a minute and retry.'
  return `Ai API error (${status})`
}

export async function POST(req: Request) {
  const auth = await requireAuth(req)
  if (!isAuthSession(auth)) return auth

  const user = await getUserData(auth.email)
  const analyzeLimit = await consumePlanUsage(auth.email, user.plan, 'analyzeDay')
  if (!analyzeLimit.ok) {
    return Response.json(
      { error: analyzeLimit.message ?? 'Analysis limit reached. Try again later.', upgradeRequired: analyzeLimit.upgradeRequired },
      { status: 429 }
    )
  }

  try {
    const { image } = await req.json()

    if (!isValidChartImagePayload(image)) {
      return Response.json({ error: 'Invalid or oversized image' }, { status: 400 })
    }

    const geminiApiKeys = getGeminiApiKeys()
    if (geminiApiKeys.length === 0) {
      return Response.json(
        {
          error:
            'Chart analysis is not configured. Add GEMINI_API_KEY (and optionally GEMINI_API_KEY_2/_3/_4) to .env.local.',
        },
        { status: 503 }
      )
    }

    const base64Data = image.split(',')[1]
    const mimeType = image.split(';')[0].split(':')[1] || 'image/jpeg'

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return Response.json({ error: 'Unsupported image type. Use JPEG, PNG, or WebP.' }, { status: 400 })
    }

    const marketContext = await buildGlobalMarketContext()

    const prompt = `You are an institutional technical analyst. Analyze this trading chart screenshot.
${marketContext}
Detect symbol/timeframe from the chart if visible. Identify trend, patterns, support/resistance, and an actionable bias.
For actionable setups use signalStatus "immediate" only when confirmation is clear; otherwise "pending confirmation" with confirmationNeeded text.
Return ONLY valid JSON (no markdown) matching this schema:
{"symbol":"string|null","signal":"BUY"|"SELL"|"HOLD","probability":0-100,"prediction":"one sentence","trend":"BULLISH"|"BEARISH"|"NEUTRAL","trendStrength":"weak"|"moderate"|"strong","pattern":"primary pattern name","secondaryPatterns":["optional"],"keyLevels":{"support":[numbers],"resistance":[numbers]},"riskLevel":"LOW"|"MEDIUM"|"HIGH","timeframe":"e.g. 4H","analysis":"2-4 sentences","recommendations":["up to 4 short bullets"],"entryPrice":number|null,"stopLoss":number|null,"takeProfit":number|null,"riskRewardRatio":number|null,"signalStatus":"immediate"|"pending confirmation","confirmationNeeded":"string when pending","signalConfirmation":{"strength":0-100,"volumeConfirmation":"string","patternConfirmation":"string","indicatorAlignment":"string","timeframeAlignment":"string","status":"string","requiredConfirmation":"string"},"aiInsights":["up to 3 bullets"]}`

    const requestBody = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }

    const models = getGeminiChatModels()
    const gemini = await generateGeminiContent(geminiApiKeys, models, requestBody, {
      userEmail: auth.email,
      source: 'chart',
    })

    if (!gemini.ok) {
      console.error(
        'Gemini error:',
        gemini.status,
        gemini.body.slice(0, 500),
        `(model: ${gemini.model})`
      )
      const message = geminiErrorMessage(gemini.status, gemini.body)
      const httpStatus =
        gemini.status === 429 ? 429 : gemini.status === 503 ? 503 : 502
      return Response.json({ error: message }, { status: httpStatus })
    }

    const data = gemini.data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> }
        finishReason?: string
      }>
      promptFeedback?: { blockReason?: string }
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        totalTokenCount?: number
      }
    }
    const candidate = data.candidates?.[0]
    const blockReason = candidate?.finishReason || data.promptFeedback?.blockReason

    if (blockReason === 'SAFETY' || blockReason === 'BLOCKLIST') {
      return Response.json(
        { error: 'Image could not be analyzed for safety reasons. Try a different chart screenshot.' },
        { status: 422 }
      )
    }

    const text = candidate?.content?.parts?.[0]?.text || ''
    if (!text) {
      return Response.json(
        { error: 'Empty response from Gemini. Try a clearer chart image.' },
        { status: 502 }
      )
    }

    const analysisResult = parseAnalysisJson(text)

    const tokenTotal = resolveTokenUsage(data, {
      outputText: text,
      inputApproxChars: prompt.length,
    }).totalTokens
    if (tokenTotal > 0) {
      await recordPlanTokens(auth.email, tokenTotal)
    }

    try {
      await addUserAnalysis(auth.email, {
        signal: String(analysisResult.signal ?? 'HOLD'),
        probability: Number(analysisResult.probability ?? 0),
        prediction: String(analysisResult.prediction ?? ''),
        riskLevel: analysisResult.riskLevel ? String(analysisResult.riskLevel) : undefined,
        timeframe: analysisResult.timeframe ? String(analysisResult.timeframe) : undefined,
      })
    } catch (e) {
      console.error('Failed to save user analysis:', e)
    }

    return Response.json(analysisResult)
  } catch (error) {
    console.error('Chart analysis error:', error)
    return Response.json({ error: 'Failed to analyze chart' }, { status: 500 })
  }
}

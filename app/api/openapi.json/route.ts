import { NextResponse } from 'next/server'
import { getApiDocs } from '@/lib/openapi-spec'

export async function GET() {
  return NextResponse.json(getApiDocs())
}

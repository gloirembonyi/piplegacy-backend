import path from 'node:path'
import swaggerJsdoc from 'swagger-jsdoc'

// Scans `app/api/**/route.ts` for `@swagger` JSDoc blocks. Coverage starts with the auth
// surface (including the new desktop OAuth exchange) and expands route-by-route — routes
// without a `@swagger` block simply don't appear in the spec yet, they still work fine.
//
// Deliberately calls swagger-jsdoc directly instead of going through next-swagger-doc's
// createSwaggerSpec(): that helper builds its glob via `path.join(process.cwd(), folder)`,
// which yields backslash-separated paths on Windows. The underlying `glob` package doesn't
// treat backslashes as path separators, so the pattern fails to match and swagger-jsdoc ends
// up handed a bare directory path, which crashes with EISDIR when it tries to read it as a
// file. Building the glob with forward slashes ourselves sidesteps that.
export function getApiDocs() {
  const apiDir = path.join(process.cwd(), 'app', 'api').split(path.sep).join('/')

  return swaggerJsdoc({
    apis: [`${apiDir}/**/*.ts`],
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Piplegacy API',
        version: '0.1.0',
        description:
          'Backend API for Piplegacy — powers the web app and the piplegacy-desktop client.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'session-token' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ms_session' },
        },
      },
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    },
  })
}

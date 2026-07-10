'use client'

import 'swagger-ui-react/swagger-ui.css'
import dynamic from 'next/dynamic'

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false })

export default function ApiDocsPage() {
  return <SwaggerUI url="/api/openapi.json" />
}

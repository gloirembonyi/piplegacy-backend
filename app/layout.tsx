export const metadata = {
  title: 'Piplegacy API',
  description: 'Standalone API backend for Piplegacy.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

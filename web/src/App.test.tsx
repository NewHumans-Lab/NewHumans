import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App bootstrap shell', () => {
  it('renders the intentionally empty application shell', () => {
    expect(renderToStaticMarkup(<App />)).toBe(
      '<main id="app-shell" aria-label="NewHumans web application"></main>',
    )
  })
})

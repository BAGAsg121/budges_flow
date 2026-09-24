'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

/**
 * next-themes wrapper.
 *
 * `attribute="class"` is what the design tokens expect (`@custom-variant dark (&:is(.dark *))`),
 * and `disableTransitionOnChange` stops every element animating at once during a theme flip.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

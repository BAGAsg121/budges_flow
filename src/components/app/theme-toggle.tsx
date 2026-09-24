'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Light / dark / system.
 *
 * The icon is only rendered after mount: the server has no idea which theme the browser
 * will pick, so rendering it during SSR causes a hydration mismatch on the icon alone.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label="Change theme">
          {!mounted ? (
            <Monitor className="h-4 w-4" />
          ) : resolvedTheme === 'dark' ? (
            <Moon className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={() => setTheme('light')} className="gap-2">
          <Sun className="h-3.5 w-3.5" /> Light {theme === 'light' ? <span className="ml-auto text-xs text-muted-foreground">•</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')} className="gap-2">
          <Moon className="h-3.5 w-3.5" /> Dark {theme === 'dark' ? <span className="ml-auto text-xs text-muted-foreground">•</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')} className="gap-2">
          <Monitor className="h-3.5 w-3.5" /> System {theme === 'system' ? <span className="ml-auto text-xs text-muted-foreground">•</span> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

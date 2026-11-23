import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'

import viteReact from '@vitejs/plugin-react'

const config = defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), ...(command === 'build' ? [nitro()] : []), viteReact()],
}))

export default config

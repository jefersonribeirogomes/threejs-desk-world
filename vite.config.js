import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

// Só ferramentas de desenvolvimento por enquanto: o site publicado continua sendo o index.html servido direto
// pelo GitHub Pages (scripts locais, sem build). Este arquivo permite usar `npm run dev` (necessário para o
// Three.js DevTools MCP) e importar shaders .glsl nos módulos novos que forem sendo extraídos.
// Atenção: `vite build` ainda NÃO gera um site completo (os scripts comuns do index.html não são empacotados).
export default defineConfig({
  base: './',
  plugins: [glsl()]
})

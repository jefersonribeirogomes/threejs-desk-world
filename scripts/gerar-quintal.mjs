// Gera quintal.html a partir de index.html (mesma interface; muda só o cenário e o título).
// Uso: node scripts/gerar-quintal.mjs   (rode sempre que alterar o index.html)
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sceneLine = "<script>window.DESK_SCENE = window.DESK_SCENE || 'quarto';</script>";
if (!src.includes(sceneLine)) throw new Error('Linha do cenário não encontrada no index.html');
const out = src
  .replace(sceneLine, "<script>window.DESK_SCENE = 'quintal';</script>")
  .replace(/<title>[^<]*<\/title>/, '<title>Quintal · Desk World · Jeferson Ribeiro Gomes</title>');
writeFileSync(new URL('../quintal.html', import.meta.url), out);
console.log('quintal.html gerado');

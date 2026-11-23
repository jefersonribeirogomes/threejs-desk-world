# Desk World: auditoria geral e plano de ação

**Data:** 22/11/2026 · **Versão auditada:** commit `82c2ee5` (`main`) · **Referência de design:** Design System Bruno Simon (seção 1)

Este plano junta tudo o que a auditoria encontrou: bugs, erros de cenário, performance, modelos, shaders, texturas, sons, efeitos e UI. Também compara o projeto com o design system e o portfólio do Bruno Simon, para mostrar o que dá para reaproveitar e o que ainda falta. No fim há um roteiro em fases, com caixas de seleção.

Prioridades usadas:

| Nível | Significado |
|---|---|
| **P0** | Quebra a experiência ou derruba a performance. Corrigir primeiro. |
| **P1** | Erro visível ou perda clara de qualidade. |
| **P2** | Refinamento ou melhoria. |
| **P3** | Ideia nova ou investimento maior. |

---

## 0. Resumo executivo

### O que foi medido

Medições no navegador (Chrome, `localhost`, qualidade alta, cena completa carregada):

| Métrica | Valor medido | Leitura |
|---|---|---|
| Tempo de **um passo de física** (`physicsStep`) | **~9,2 ms** | Crítico. A física roda a 60 Hz, ou seja, mais de 500 ms de CPU por segundo. Quase todo o custo está em `stepDynamicObjects` (8,8 ms). |
| Objetos dinâmicos / obstáculos | 212 / 476 | Geram 14,6 mil pares objeto×objeto por passo, além de ~100 mil testes objeto×obstáculo fixo. |
| Chamadas de desenho na largada | 780 (era 415 na auditoria anterior) | Regressão: o conteúdo novo (rally, plantas, lápis, caixas) não foi agrupado. |
| Malhas na cena / triângulos | 2.814 / ~625 mil | Normal para o tamanho, mas com muita malha pequena. |
| Objetos que projetam sombra | 1.121 | O passe de sombra praticamente dobra as chamadas de desenho. |
| Luzes pontuais (`PointLight`) | **16** | Cada material PBR calcula 16 luzes por pixel. Uma delas está com intensidade 0 (fogo do monitor) e ainda assim custa. |
| Materiais na cena | 2.018 sem textura, só **287 combinações distintas** | 1.731 materiais duplicados (mesma cor, rugosidade e metalicidade). |
| Malhas de grama | 117 (39 mil lâminas) | Daria para juntar em 4 a 6 malhas por região. |
| Programas de shader | 48 | OK. |
| Erros no console | 0 | OK. |

### As 10 decisões mais importantes

1. **Física em grade espacial + objetos dormindo** (P0). O passo de física deve cair de ~9 ms para menos de 1 ms.
2. **Sombra que acompanha o carrinho** (P0). Hoje a área de sombra é fixa em ±85 ao redor da origem, então o rally, as ilhas e as bordas do quarto ficam sem sombra.
3. **Mapa desatualizado** (P0). O limite ainda é `x = 240`, mas o quarto vai até 330. Faltam no mapa a Ilha da Fogueira, a ponte, a montanha e a largada do rally.
4. **No máximo 4 luzes pontuais reais** (P1). As outras viram brilho emissivo, sprites ou luz "assada".
5. **Agrupar materiais e malhas** (P1): cache de materiais, junção da grama e `InstancedMesh` para objetos repetidos.
6. **Sons de verdade no lugar do sintetizador** (P1). Hoje 100% do áudio é `playTone`.
7. **Atmosfera** (P1): névoa e um ciclo dia/noite leve, como os `dayCycles` do DS. O mundo hoje não tem profundidade.
8. **Piso que vaza para fora das paredes** (P1). O plano do chão (550×260) passa das paredes norte e sul.
9. **Arquitetura** (P2). O `index.html` tem 15.316 linhas e 357 funções. Retomar a migração em etapas para módulos.
10. **Licença antes de reaproveitar** (P0, processo). Os sons do espelho do site são de bancos comerciais, e a licença do portfólio de 2025 não foi confirmada. Reaproveitar técnicas, recriar os assets.

---

## 1. Design system de referência

**Arquivo principal:** `C:\Users\enext\Downloads\bruno-simon.com\bruno-simon-design-system\design-system.html`. A partir de agora ele é a fonte oficial de UI e estilo do projeto (registrado na memória do assistente).

**Espelho completo do portfólio:** `C:\Users\enext\Downloads\bruno-simon.com\bruno-simon.com\site\bruno-simon.com\`. Ele traz:
- 23 modelos GLB comprimidos com Draco;
- texturas KTX2/Basis;
- ~40 efeitos sonoros MP3;
- o bundle JS (Three r187 WebGPU/TSL + física Rapier).

**Porte atual no projeto:** `assets/css/bruno-ds.css` (2.030 linhas) e `assets/ui/` (ícones, prévias, recompensas, mapa).

### ⚠️ Licença: o que pode e o que não pode

| Tipo | Situação | Como usar |
|---|---|---|
| Tokens visuais (cores, tipografia, raios, gradientes) | Ideias de estilo, não são protegidas como asset | ✅ Já em uso; seguir à risca. |
| Técnicas: ciclo dia/noite, clima, rastro de pneu, folhagem SDF, paleta em textura | Conhecimento | ✅ Reimplementar do zero. |
| Fontes Amatic SC, Nunito e Pally | Licenças abertas (OFL / Fontshare) | ✅ Já em uso. |
| Modelos GLB do espelho (árvores, bancos, cercas, lanternas, postes, caixas explosivas) | Licença do folio-2025 **não confirmada** (o folio-2019 era MIT para código) | ⚠️ Só como referência até confirmar o `LICENSE` no GitHub ou ter permissão do autor. Recriar no mesmo estilo low-poly. |
| Sons MP3 do espelho (nomes como `SIG014001`, `TTX028903`, `BW.60329`, `PE281202`) | Vêm de bibliotecas comerciais (Pro Sound Effects, BOOM e similares) licenciadas para ele, **não redistribuíveis** | ❌ Não copiar. Usar equivalentes CC0 (seção 6). |
| Imagens de UI já copiadas (`assets/ui/map/map-day.webp`, `previews/*.webp`, `rewards/*.webp`) | São do mundo dele | ⚠️ Substituir por capturas do Desk World (ver P1-UI-3). |

Além da licença, há uma questão de identidade: o Desk World é o portfólio do Jeferson visto pelos olhos do Ravi. Reaproveitar o **estilo** e as **técnicas** é o caminho. Copiar o mundo dele (mesmos objetos, mesmo mapa, mesmos sons) faria o site parecer uma cópia do bruno-simon.com.

---

## 2. Bugs e erros de cenário

### P0: corrigir já

| # | Problema | Onde | Correção |
|---|---|---|---|
| B1 | **Física lenta: 9 ms por passo.** O teste de pares é O(n²), sem fase ampla, e roda até nos objetos parados. Também há testes contra todos os 476 obstáculos, 6 passadas de correção e a verificação de tijolos apoiados (`dynamicObstacles.some`). | `stepDynamicObjects`, `dynamicObjectBlockedAt`, `dynamicOverlapsOtherDynamic` | (1) Grade espacial (células de 8 u) reconstruída a cada passo só com objetos acordados. (2) Estado `sleep`: um objeto parado e a mais de 20 u do carrinho é pulado. (3) Obstáculos fixos numa grade estática feita uma vez só. (4) Medir de novo; meta abaixo de 1 ms. |
| B2 | **A área de sombra não acompanha o carrinho.** `mainLight.shadow.camera` fica fixa em ±85 ao redor de (0,0,0): o rally (x 130–330), as ilhas a oeste e o canto da cama ficam sem sombra. | Bloco `--- ILUMINAÇÃO ---` | Mover `mainLight.position` e `mainLight.target` junto com o carrinho a cada quadro, em passos de texel para não tremer. Em qualidade baixa, raio de 60. |
| B3 | **Mapa com limite antigo** (`MAP_MAX_X = 240`, sendo que o quarto vai até 330) e sem os locais novos. | `MAP_MIN_X/MAX_X`, `MAP_LOCATIONS` | `MAP_MAX_X = 330`. Adicionar Ilha da Fogueira, Largada do Rally, Ponte, Montanha da Cachoeira e Lago do miolo. Corrigir a posição da Ilha do Baja (185, 64). |
| B4 | **Piso vaza para fora das paredes.** O plano do chão (x −190…360, z −120…140) aparece além das paredes norte e sul na vista aérea e no mapa. | `floorGeo` (bloco do chão do quarto) | Recortar o plano em x −170…330 e z −75…95. |

### P1: erros visíveis

| # | Problema | Correção |
|---|---|---|
| B5 | **Luz morta:** o `fireLight` do monitor tem intensidade 0, mas continua na contagem de luzes (custo por pixel em todo o mundo). | Ligar `visible` só durante o incêndio, ou trocar por emissivo + sprite de brilho. A troca de `visible` recompila shaders; o certo é manter um número fixo de luzes "reaproveitáveis". |
| B6 | **Rebarbas na lateral esquerda do notebook:** sobraram uma haste e faixas claras perto do braço articulado (não confirmado no último print). | Revisar as peças do `lapBaseGroup` e do braço; capturar de perto e remover o que sobrar. |
| B7 | **Capotamento automático do Baja frequente demais** (2 por volta no teste automático: aterrissagens na ponte e encostas). | Subir os limites (impacto > 0,75; rolagem > 0,7 por 0,25 s seguidos) e só considerar quando o carro estiver com velocidade lateral. |
| B8 | **Laço oeste do rally apertado:** cerca de 4 u de folga entre a pista externa e o miolo em (156,−4) × (140,−6). | Mover os pontos `[156,-4]` e `[164,-26]` cerca de 6 u para leste. |
| B9 | **Cascas dos túneis do rally claras demais** de cima (parecem estufas). | Escurecer o `mossMat`, adicionar pedras e moitas na cumeeira (os túneis da montanha não têm) e terra nas bordas. |
| B10 | **A montanha virou um morro pequeno** depois dos cortes das estradas. | Aumentar `MOUNTAIN.h` para 20 e `r` para 30, e subir a cachoeira junto (`lip`). |
| B11 | **Partículas `spawnFx` criam uma `Mesh` nova a cada partícula** (confete, faísca, respingo): é lixo para o coletor de memória e uma chamada de desenho por partícula. | Um único `InstancedMesh` de 600 partículas com pool, igual às gotas de lama. |
| B12 | **Tabuleiro da ponte sem tábuas em 3D:** só cor de vértice. Perto da câmera parece liso. | Juntas transversais (`InstancedMesh` de ripas) e pregos/vigas nas laterais. |
| B13 | **Rótulos de obstáculo do rally sempre visíveis** e do mesmo tamanho a qualquer distância. | Esmaecer pela distância (> 60 u) e esconder no mapa. |
| B14 | **O teste local para quando a janela não está em foco** (o `requestAnimationFrame` congela). É comportamento esperado do navegador, mas complica testes automáticos. | Expor `window.__step(n)` em `localhost` para avançar a física nos testes. |

### P2: qualidade

- **Folhas soltas e grama:** as lâminas não fazem sombra nem recebem iluminação (`MeshBasic`/shader próprio). Somar a cor da luz e um falso sombreamento por altura (*fake AO*), como o `leaves.seeThroughMultiplier` do DS.
- **Objetos GLB que ainda não têm colisão** e ficam sobrepostos a objetos com física: revisar com um script de auditoria que liste obstáculos sobrepostos no mesmo nível.
- **Ajuste fino dos objetos espalhados:** há palitos e post-its quase brancos na mesa escura que parecem falhas. Variar a cor e adicionar sombra de contato.

---

## 3. Performance (plano de otimização)

| Ação | Ganho esperado | Prioridade |
|---|---|---|
| Grade espacial + objetos dormindo (B1) | −8 ms de CPU por passo | P0 |
| Sombra que segue o carrinho + `castShadow` só em objetos com mais de 1 u (já há `pruneTinyShadowCasters`, estender ao rally) | −30% das chamadas no passe de sombra | P0 |
| Cache de materiais `mat(color, rough, metal, flags)` | 2.018 → ~290 materiais, menos troca de estado | P1 |
| Juntar a grama por região (`mergeBufferGeometries`) | 117 → ~6 malhas | P1 |
| `InstancedMesh` para pneus empilhados, cones do rally, barris, fardos, caixotes, pedras e estacas da ponte | −150 chamadas de desenho | P1 |
| No máximo 4 luzes reais + brilho falso (sprite aditivo + emissivo) | Pixel mais barato no mundo inteiro | P1 |
| Remoção por distância (*distance culling*) por setor (mesa, quarto oeste, rally): `group.visible = dist < limite` | Rally fora de vista quando o carrinho está na mesa | P1 |
| Texturas em KTX2/Basis (o DS usa `.ktx.bin` para tudo) | Menos memória de GPU e decodificação | P2 |
| GLB com Draco/Meshopt (`gltfpack`) | −60 a 80% no download dos modelos | P2 |
| Medidor de performance em `localhost` (`stats.js` + `renderer.info`) | Visibilidade contínua | P2 |

---

## 4. Cenário e modelos: refinamento

### Mesa (escala "brinquedo")
- **Notebook:** ver B6. Adicionar uma luz suave do teclado (emissivo) e reflexo na tela.
- **Teclado mecânico:** teclas instanciadas, ótimo. Falta um "clique" sonoro por tecla (seção 6).
- **Monitor:** trocar os cones de fogo do incêndio pelo shader de chama da fogueira (já existe o `flameMaterial`).
- **Copo d'água, caneca e aquário:** bons. Adicionar gotículas no copo (*normal map* procedural) e bolhas no aquário.
- **Plantas em vaso:** já com folhas em cartões. Falta trocar o cacto por um cacto com espinhos em cartões e flor.
- **Lápis:** acrescentar desgaste na ponta (cone que encurta) e lascas de madeira ao apontar.

### Quarto
- **Cama do Ravi:** cobertor com shader de tecido (padrão + dobras por ruído) e travesseiro que afunda quando o carrinho sobe.
- **Paredes:** acrescentar rodapé com tomadas, janela com cortina balançando com o vento e luz do dia entrando (combina com o ciclo dia/noite, seção 7).
- **Piso:** variar o rejunte e as manchas (textura de azulejo com mais ruído) e acrescentar um tapete de brinquedo com ruas desenhadas.
- **Yucca grande:** folhas em cartões com vento, como as plantas da mesa.

### Rally
- **Ponte:** ver B12. Adicionar placa "PONTE" e cordas de guarda-corpo.
- **Montanha:** ver B10. Adicionar caminho de pedras e uma placa de túnel com "13" (referência ao Baja).
- **Cachoeira:** mais volume, com duas camadas de água em velocidades diferentes, espuma na base com partículas e arco-íris na névoa.
- **Lama:** ok depois do shader. Acrescentar rastro de pneu persistente na lama (seção 5, *tracks*).
- **Público:** bonecos de papelão (Ravi, família) acenando nas curvas; recriar no estilo dos bancos e cercas do DS, sem copiar.
- **Postes de luz e lanternas** ao longo do rally para o modo noite (seção 7).

### Baja 13
- Painéis laterais com o padrão roxo em cartões dobrados (hoje são caixas finas).
- Para-choque com placa do número em relevo, mais um adesivo do patrocinador no capô.
- Volante que gira com a direção e capacete do piloto que inclina nas curvas.

### Caminhãozinho do Ravi
- Escada que estica ao segurar a mangueira, giroflex com luz falsa projetada no chão e decalque "Ravi" no lugar de "Fire Engine".

---

## 5. Shaders e texturas

| Item | Situação | Ação |
|---|---|---|
| **Paleta em textura** (`palette.ktx.bin` do DS) | O projeto usa uma cor por material, por isso os 1.731 duplicados | Criar `palette.png` 16×16 com as cores do projeto e usar UV de paleta nos objetos procedurais: um material só para quase tudo (técnica do DS). |
| **Folhagem com SDF** (`foliageSDF.ktx.bin`) | Usamos a `leafTexture` em canvas com corte alpha (serrilha de perto) | Gerar uma textura SDF da folha (contorno com distância) e recortar com `smoothstep` no shader: bordas nítidas em qualquer zoom. |
| **Rastro de pneu** (`tracks.renderTarget` do DS) | Hoje não há rastro | Render target de cima (512²) que segue o carrinho e desenha a marca das rodas. É lido pelos shaders de lama, terra e areia do lago. |
| **Névoa** (`fog.color`/`strength` do DS) | Não há névoa | `THREE.Fog` com cor do céu do ciclo + névoa por altura no shader do chão. |
| **Bloom** (43 ocorrências no DS) | Não há pós-processamento | Bloom leve só nos emissivos (chama, nitro, lâmpadas, cristal), via `UnrealBloomPass` com *threshold* alto. Desligado na qualidade baixa. |
| **Contorno / cel shading** (*outline*, `cel` no DS) | Proposto antes e não feito | Rampa de iluminação em 3 tons (*toon ramp*) via `onBeforeCompile` nos materiais procedurais e contorno por normais invertidas só no carrinho e nos interativos. |
| **Overlay de transição** (`overlayPattern.ktx.bin`) | A intro usa um anel | Transição de troca de veículo e teleporte com padrão de pontos (*halftone*) em tela cheia. |
| **Terreno com textura assada** (`terrain.ktx.bin`) | Chão em azulejo procedural | Assar a oclusão de contato sob a mesa, os móveis e as ilhas numa textura de *lightmap* do piso. |
| **Água** | Shader próprio bom (lago, poças, riacho, cachoeira) | Acrescentar cáusticas no fundo raso e ondas que o carrinho provoca (anel que se expande). |
| **Chama da fogueira** | Shader com ruído | Reutilizar no monitor (B-cenário), na tocha do posto e no escape do nitro. |

---

## 6. Sons

Hoje tudo é sintetizado (`playTone`). Proposta: um sistema `audio.js` com `AudioBuffer`, um *pool* de vozes, variação de altura e volume por evento, mixagem por categoria (motor, impactos, ambiente, UI e música) e respeito ao botão de áudio do DS.

| Evento | Referência no DS (só como ideia) | Fonte livre sugerida |
|---|---|---|
| Motor em marcha lenta e aceleração (altura segue a velocidade) | `vehicle/engine` | Kenney "Sci-Fi Sounds" / freesound CC0 "toy car engine loop" |
| Rodas no piso, na terra, na lama e na madeira da ponte (troca pela superfície) | `vehicle/floor` | freesound CC0 "gravel roll loop", "mud squelch" |
| Molas e suspensão do Baja | `vehicle/springs`, `suspensions` | Kenney "Impact Sounds" |
| Buzina (bi-bi) | `vehicle/honk` | Gravar uma buzina de brinquedo real (som próprio do Ravi!) |
| Pintar com lápis | `vehicle/paint` | freesound CC0 "crayon scribble" |
| Batidas leves, médias e fortes (por massa) | `hits`, `anvil`, `bell` | Kenney "Impact Sounds" (CC0) |
| Explosão da caixa-surpresa e da bateria | `explosions` | Kenney "Explosion Pack" (CC0) |
| Papel e post-it voando | `paper` | freesound CC0 "paper flutter" |
| Bola rolando e boliche | `rolling`, `hits/pins` | Kenney + freesound CC0 "bowling pins" |
| Circuito (contagem, checkpoint, fim, aplausos) | `circuit/*` | Kenney "Digital Audio" + "UI Audio" (CC0) |
| Conquista e moeda | `achievements`, `ding` | Kenney "UI Audio" (CC0) |
| Swoosh de menus | `swoosh`, `stoneSlides` | Kenney "UI Audio" |
| Ambiente: vento, cachoeira, fogueira e pássaros (posicional, volume pela distância) | `magic/*` (loops) | freesound CC0 "campfire loop", "waterfall loop" |
| Trovão (se houver clima) | `thunder/*` | freesound CC0 |

As músicas da Ilha da Música hoje são sintetizadas. Gravar as três cantigas em caixinha de música (licença própria) daria muito mais personalidade.

---

## 7. Efeitos e VFX

| Efeito | Situação | Proposta |
|---|---|---|
| **Ciclo dia/noite** (`dayCycles` do DS: presets, eventos e progresso) | Não existe | Ciclo de 6 a 10 minutos: manhã, tarde, pôr do sol e noite. Interpolar a cor e intensidade da luz, a névoa, a cor do fundo e a cor da `envMap`. À noite, acender o abajur, as lanternas do rally, a fogueira e as luzes do quarto. Botão no menu Opções. |
| **Clima** (`weather` do DS: chuva, neve, vento, raios) | Só vento | "Chuva de brinquedo": chuva instanciada com respingos no chão, poças que crescem e lama mais escorregadia. "Neve" de papel picado. Raio + trovão à noite. Conquistas novas para cada clima. |
| **Rastro de pneu** (*tracks*) | Não existe | Ver seção 5. |
| **Confete** (`confetti.pop` do DS) | Existe com malha por partícula | Migrar para o pool instanciado (B11) e acrescentar "serpentina" (fitas). |
| **Vagalumes** (`fireflies` no DS) | Não existe | À noite, na Ilha da Fogueira e no lago: pontos aditivos com movimento de ruído. |
| **Brilho de interação** (anel e diamante) | Existe | Acrescentar o pulso do DS (`cubic-bezier(.49,2.2,.53,.75)`) e o ícone de tecla flutuante (`interactivePointsKeyIcon*` do DS: "A", "Enter", "X" conforme o controle). |
| **Fumaça do escape** | Só faíscas no turbo | Fumaça leve no arranque e fumaça escura quando a bateria está baixa. |
| **Impacto** | Som + vibração do controle | Leve tremida de câmera proporcional ao impacto e partículas da cor do objeto atingido. |

---

## 8. UI × design system (conformidade)

| Componente do DS | No projeto | Ação |
|---|---|---|
| Menu dividido em duas colunas (prévia + conteúdo, 1000×600) | ✅ Abas Início, Opções, Controles, Circuito, Conquistas e Bastidores (log) | Trocar as prévias (`assets/ui/previews/*.webp`, imagens do mundo dele) por capturas do Desk World. |
| Navegação de 7 ícones | 6 abas | Acrescentar a 7ª aba **"Recados do Ravi"** (versão própria dos *Whispers*, ver seção 10). |
| Toasts com `time-bar` e entrada com mola | ✅ `notify` | Conferir as variantes `is-song`, `is-achievement` e `is-server-*` com as cores do DS (#ffc67b / #d5ff95 / #ff6a7c). |
| Tooltip #141414 com borda #ffceca e ponteiro em losango | Parcial (só nas recompensas) | Usar nos botões de Opções (áudio, qualidade, renderizador), igual ao DS. |
| Botões `.is-success` / `.is-danger` / `.is-disabled` (tracejado) | Parcial | Status do servidor (Firebase online/offline) e "Respawn" desabilitado durante a corrida. |
| **Botões "Respawn" e "Unstuck"** | ❌ (só teleporte pelo mapa) | "Desvirar/Destravar" volta à última posição segura, e "Respawn" leva ao ponto de respawn mais próximo. Essencial no rally (capotamentos). |
| Etiqueta de 3 letras do ranking com seletor de bandeira | Etiqueta ✅, bandeira ❌ | Seletor de bandeira opcional (sem dado pessoal além do país). |
| Ranking diário com "Reseta em…" | Ranking global ✅ | Mostrar a contagem regressiva do reset diário, se o ranking virar diário (Cloud Function). |
| Grade de recompensas (46×46, travada com cadeado) | ✅ | Acrescentar recompensas do Baja (pinturas Piratas do Vale e Lama). |
| **Mapa dia/noite** com pins em losango | Mapa capturado ao vivo ✅, sem noite | Com o ciclo dia/noite, a captura já sai noturna. Corrigir os limites (B3). |
| Modal de fim de volta com estado Top 10 | ✅ Circuito | Reaproveitar no **rally** (hoje só há uma notificação). |
| Barra de ações de toque (Interagir / Destravar) | Parcial | Acrescentar "Destravar" e "Cambalhota" quando o Baja estiver no ar. |
| Tipografia (Amatic 64/48 no toque; Nunito 900 no cronômetro) | ✅ | Conferir os tamanhos responsivos (20/18/16px na raiz). |

---

## 9. O que pode ser reaproveitado do DS e do espelho

| Asset / sistema do espelho | Uso proposto no Desk World | Como trazer |
|---|---|---|
| `birchTrees`, `oakTrees`, `cherryTrees` (*Visual* + *References*) | Floresta do rally e das ilhas | Estudar a técnica: copa em cartões + instâncias por referência (posições num GLB de "references"). Recriar as copas, que já fazemos com cartões. |
| `bushes`, `flowers` | Moitas e canteiros | Mesmo esquema de referências: posições num GLB, instanciado. |
| `benches`, `fences`, `lanterns`, `poleLights` | Rally, lago e posto | Modelar versões próprias low-poly com a paleta (seção 5). |
| `explosiveCrates` | Já temos a caixa-surpresa | Referência para animação de estouro (tampa + tábuas). |
| `bricks` | Já temos o muro | — |
| `playground` (balanços, escorregador) | **Parquinho do Ravi** (novo setor) | Recriar no tema infantil. |
| `respawns` | Pontos de respawn | Implementar o botão "Respawn" (seção 8). |
| `tornado` (`tornadoPathReferences`) | Evento "Ventania" | Redemoinho de folhas e papéis que passeia pelo quarto e carrega objetos leves. Reaproveita o sistema de detritos. |
| `whisperFlame.ktx` + Whispers | "Recados do Ravi" | Visitantes deixam frases de até 30 caracteres no mundo (balão + chama). Requer moderação no Firestore. |
| `jukeboxMusicNotes.ktx` | Ilha da Música | Notas musicais saindo do piano/rádio quando toca música. |
| `timeMachineScreen*` | **Máquina do tempo da carreira** | Uma TV antiga que mostra as versões anteriores do portfólio do Jeferson. |
| `achievements/glyphs.ktx` | Conquistas | Glifos 3D no mundo quando uma conquista é desbloqueada. |
| `palette.ktx` | Paleta única | Seção 5. |
| `foliageSDF.ktx` | Folhas nítidas | Seção 5. |
| `terrain.ktx` | Chão assado | Seção 5. |
| `overlayPattern.ktx` | Transições | Seção 5. |
| `interactivePointsKeyIcon*` | Ícone de tecla flutuante | Seção 7. |
| Sons | Ver seção 6 | **Não copiar**: substituir por equivalentes CC0. |

**Técnicas do bundle que valem estudo:** física Rapier (no lugar da nossa física própria), renderizador WebGPU com materiais TSL (Three r187) e eventos de intervalo do ciclo dia/noite (`dayCycles.intervalEvents`).

---

## 10. Novos recursos (ideias)

| Ideia | Descrição | Esforço |
|---|---|---|
| **Recados do Ravi** | Versão própria dos *Whispers*: o visitante escreve uma frase curta que aparece como balão no mundo (Firestore + moderação por lista de palavras + limite por usuário). | M |
| **Ventania** (tornado de folhas) | Evento aleatório que reaproveita o sistema de detritos; conquista "Sobreviveu à ventania". | M |
| **Ciclo dia/noite + chuva** | Seção 7; muda a sensação do mundo inteiro. | M |
| **Respawn / Destravar** | Seção 8; obrigatório no rally. | P |
| **Modo foto** | Pausa, câmera livre, filtros (sépia, desenho) e download PNG. | P |
| **Fantasma da melhor volta** | Grava a trajetória e mostra um carro translúcido no circuito e no rally. | M |
| **Garagem** | Ilha para trocar de veículo (caminhão, Baja, futuros) com prévia girando. | M |
| **Missões do dia** | 3 tarefas diárias ("regue 2 plantas", "estoure 1 caixa", "volta no rally abaixo de 60 s"). | M |
| **Máquina do tempo da carreira** | TV antiga com as versões anteriores do portfólio. | P |
| **Parquinho do Ravi** | Setor novo com balanço, escorregador e gangorra com física. | G |
| **Multijogador leve** | Ver os carrinhos de outros visitantes (posição a cada 200 ms via Firestore/WebRTC). | G |
| **Acessibilidade** | Reduzir movimento, alto contraste, legendas para sons e controle só com uma mão. | P |

Esforço: P = pequeno · M = médio · G = grande.

---

## 11. Arquitetura e infraestrutura

| Item | Situação | Ação |
|---|---|---|
| `index.html` monolítico (15.316 linhas, 357 funções) | Difícil manter | Retomar a migração **em etapas** (decisão pendente). Ordem sugerida: `physics/`, `rally/`, `nature/` (vento, folhagem, detritos), `audio/`, `ui/`. Cada etapa com o build do Vite publicando em `dist/`. |
| Three r128 (2021) via script global | Sem WebGPU, sem TSL, API antiga (`outputEncoding`) | Atualizar para r16x/r17x via npm (já está em `package.json`, sem uso). Exige ajustar `sRGBEncoding` → `SRGBColorSpace`, as luzes físicas e os `onBeforeCompile`. |
| Física própria O(n²) | 9 ms por passo | Curto prazo: grade espacial (B1). Médio prazo: avaliar a Rapier (WASM), como o DS. |
| Deploy | GitHub Pages servindo o `index.html` cru | Publicar o `dist/` do Vite (com hash e minificação) via GitHub Actions. |
| Vulnerabilidades do npm | 2 no Vite/esbuild (só ambiente de desenvolvimento) | Atualizar o Vite para a versão 6+. |
| App Check | Chave de site pendente | Aguardando a chave de site do Fraud Defense. |
| Testes | Manuais | Página de teste em `localhost` com `window.__step(n)` e cenários automatizados (volta do rally, empurrar objetos, explosão de caixas). |

---

## 12. Roteiro em fases

### Fase 1: estabilidade e performance (1 a 2 semanas)
- [x] B1: física com grade espacial + objetos dormindo. Medido: de 9,2 ms para 0,5 ms (mesa) e 0,8 ms (rally) por passo; o muro de tijolos e os empurrões continuam funcionando.
- [x] B2: sombra seguindo o carrinho (com passo de texel para não tremer)
- [x] B3: mapa com limite x = 330 e locais novos (Largada do Rally, Ponte, Montanha, Ilha da Fogueira)
- [x] B4: piso recortado nas paredes (mesmo tamanho de azulejo)
- [x] B5: de 16 para **4 luzes pontuais ativas**. Os postes e os túneis ganharam brilho falso (sprite aditivo) e o aquário ficou só com o LED emissivo. *Correção da auditoria:* o `fireLight` não custava nada fora do incêndio, porque fica num grupo invisível.
- [x] B11: pool instanciado para `spawnFx` (1 chamada de desenho; também corrige o tamanho da partícula, que era ignorado)
- [x] Grama em lote por região: de 117 para 23 malhas
- [x] Sombra só para peças com raio de 0,8 ou mais (o carrinho sempre faz sombra)
- [ ] Cache de materiais + `InstancedMesh` dos objetos repetidos do rally
- [ ] Medidor de performance em `localhost` (já existe `window.__step(n)` para testes de física)
- [x] Extra: link do projeto do Thiago corrigido (piratasdovalepcp.netlify.app) e posto de recarga na Ilha do Baja
- [x] Kenney Racing Kit no rally: pórtico de largada com luzes, bandeiras quadriculadas, 2 arquibancadas cobertas, 6 torres de banner, 16 postes de luz (prontos para o modo noite), 3 tendas de box, torre de cronometragem e outdoor com arte própria. Créditos em `models/kenney/CREDITS.md`.
- [x] CSP: `blob:` liberado em `connect-src`. Era necessário para texturas embutidas nos GLBs (o `fetch` de `blob:` era bloqueado).
- [x] Rótulo da Ilha do Baja encurtado (estava cortado)

### Fase 2: acabamento visual e de cenário (2 semanas)
- [ ] B6: rebarbas do notebook (falta conferir de perto)
- [x] B7: capotamento automático mais raro (aterrissagem > 0,78 e inclinação lateral sustentada por 0,25 s). Volta de teste completa sem capotamentos.
- [x] B8: laço oeste ~6 u mais largo (lago, lamaçal e rampa acompanharam)
- [x] B9: musgo dos túneis mais escuro
- [x] B10: montanha maior (r 30, altura 20) e cachoeira mais alta (13)
- [x] B12: tábuas 3D na ponte alta (instanciadas, 1 chamada de desenho)
- [x] B13: rótulos dos obstáculos do rally somem com a distância
- [x] Pilha de pneus = 1 malha (antes 3): −100 chamadas de desenho
- [x] Bug: teleporte não zerava o cronômetro do rally (dava recorde falso). Corrigido; volta real medida: 37,5 s.
- [ ] Paleta em textura e folhagem SDF
- [ ] Névoa + bloom leve (qualidade alta)
- [ ] Prévias do menu com capturas do Desk World (substituir as imagens do mundo do Bruno)
- [ ] Refinamentos de modelos da seção 4 (prioridade: Baja, ponte, cachoeira, cama)

### Fase 3: som e atmosfera (2 semanas)
- [x] Sistema de som com pacotes Kenney CC0. São 68 sons em `assets/sfx`, com variação de tom, limite de 24 vozes e volume geral. Há botão **Áudio** em Opções (salvo no aparelho), e o som sintetizado fica de reserva para navegadores sem OGG. Eventos com som novo:
  - batidas por peso e material (leve, madeira, pesado, metal, vidro, parede);
  - pilhas (comum e dourada), nitro, cambalhota e pulos;
  - explosões da caixa-surpresa e da bateria, estouro das caixinhas, pinos de boliche;
  - contagem, checkpoint e fim de volta (circuito e rally);
  - conquistas, recompensas, menus, cliques, pegar/soltar e lama.
- [x] Nature Kit (Kenney):
  - montanha com pinheiros, rochas, troncos e cogumelos;
  - Ilha da Fogueira com barraca, lenha, tocos, placa e flores;
  - vitórias-régias de verdade no lago do miolo e canoa no lago do quarto;
  - tocos e cogumelos na floresta do rally.
- [ ] Integrar Toy Car, Furniture, Food e Minigolf Kit (já baixados em `Downloads\kenney`)
- [ ] Ciclo dia/noite com luzes noturnas
- [ ] Chuva de brinquedo + trovão
- [ ] Rastro de pneu na lama, na terra e na areia

### Fase 4: recursos novos (contínuo)
- [ ] Respawn / Destravar (fazer antes de tudo nesta fase)
- [ ] Modal de fim de volta para o rally (ranking próprio)
- [ ] Recados do Ravi (Whispers próprio)
- [ ] Ventania, fantasma da melhor volta, modo foto
- [ ] Migração em etapas para módulos + atualização do Three

---

## 13. Decisões pendentes (do Jeferson)

1. **Licença dos assets do Bruno Simon:** confirmar o `LICENSE` do repositório folio-2025 ou pedir permissão ao autor antes de usar qualquer GLB ou textura dele. Os sons não devem ser usados de jeito nenhum.
2. **Migração de arquitetura:** "em etapas" (recomendado) ou "completa".
3. **Atualizar o Three.js** (r128 → atual) junto com a migração ou depois dela.
4. **Recados do Ravi:** aceitar texto de visitantes exige moderação. Quer esse recurso?
5. **Chave de site do App Check** (Fraud Defense).

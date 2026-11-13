# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`12 - Arquitetura Desacoplada: Setup Local vs Trabalhador Efêmero (GitHub Actions)`

---

## [Context]
A arquitetura do bot foi formalmente separada em dois pontos de entrada totalmente isolados:
1. **Controle Remoto Local (`src/setup.ts`)**: Servidor Express com interface visual SaaS corporativa em `public/index.html` para login via QR Code, listagem de grupos do WhatsApp e gerenciamento da tabela `obras_config`.
2. **Trabalhador Efêmero (`src/bot.ts`)**: Script desenhado especificamente para rodar como Cron Job no GitHub Actions a custo zero, durando 75 segundos, consumindo mensagens não lidas, extraindo agendamentos via Gemini, disparando infográficos em imagem e briefings em áudio, e encerrando graciosamente com `process.exit(0)`.

---

## [Completed]
- [x] **Módulo 1: Controle Remoto Local (`src/setup.ts`)**:
  - Servidor Express dedicado na porta 3000.
  - Conexão com o Baileys usando `useSupabaseAuthState` exclusivamente para gerar o QR Code inicial e popular o banco.
  - API REST completa para CRUD de `obras_config` e eventos do FullCalendar.
  - Nenhum processamento de mensagens ou disparos de cron ocorre neste script.
- [x] **Módulo 2: Trabalhador Efêmero (`src/bot.ts`)**:
  - Restaura a sessão do WhatsApp direto da tabela `baileys_auth_state` do Supabase sem necessidade de QR Code.
  - Lê as mensagens não lidas recebidas via `messages.upsert` e `messaging-history.set`.
  - Filtro dinâmico: processa apenas mensagens cujos grupos existam em `obras_config`.
  - Deduplicação rígida consultando a tabela `mensagens_processadas`.
  - Processamento NLP com Google Gemini (com detecção de conflitos logísticos).
  - Rotinas de disparos em imagem (PNG de Timeline) e Morning Briefing em áudio nativo (TTS Voice Note / PTT).
  - Graceful Shutdown programado para 75s com salvamento de credenciais e `process.exit(0)`.
- [x] **Módulo 3: Workflow do GitHub Actions (`.github/workflows/bot-cron.yml`)**:
  - Cron a cada 3 horas (`0 */3 * * *`) e gatilho manual `workflow_dispatch`.
  - Execução direcionada para `node dist/bot.js`.
  - Mapeamento das secrets (`SUPABASE_URL`, `SUPABASE_KEY`, `GEMINI_API_KEY`).
- [x] **Ajustes no `package.json`**:
  - Scripts dedicados: `"start:setup": "ts-node src/setup.ts"`, `"start": "node dist/bot.js"`, `"build": "tsc"`.

---

## [Pending / Next Steps]
1. [ ] No painel do Render, pausar ou desativar o Web Service (já que a execução será efêmera via GitHub Actions).
2. [ ] No GitHub (`Settings > Secrets and variables > Actions`), verificar se as secrets estão configuradas (`SUPABASE_URL`, `SUPABASE_KEY`, `GEMINI_API_KEY`).
3. [ ] Executar o `git push origin main` para atualizar o workflow no GitHub Actions.

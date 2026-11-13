# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`13 - Arquitetura Híbrida Definitiva: Render Web Service + Despertador GitHub Actions`

---

## [Context]
Adotada a solução definitiva: o sistema roda como um **Web Service unificado no Render** (`src/server.ts`) servindo o Dashboard corporativo SPA e a conexão contínua do WhatsApp. O **GitHub Actions** atua como um **Cron Trigger (Despertador)** através do workflow `.github/workflows/wake-render.yml`, enviando requisições HTTP para `/api/wake` nos horários estratégicos de relatórios para acordar a instância do Render e manter o serviço 100% gratuito.

---

## [Completed]
- [x] **Módulo 1: O Servidor Unificado (`src/server.ts`)**:
  - Express escutando na porta `process.env.PORT || 3000`.
  - Serve arquivos estáticos da pasta `public/` (Dashboard SPA).
  - Rota do Despertador: `GET /api/wake` respondendo com timestamp e status do WhatsApp.
  - Endpoints REST para CRUD de `obras_config`, `agenda_obra` e dados para o FullCalendar.
  - Conexão Baileys contínua com reconexão automática e persistência em Supabase Auth State.
  - Processamento de mensagens em tempo real com Gemini, detecção de conflitos, cartões de confirmação, relatórios em imagem e áudio TTS.
- [x] **Módulo 2: O Frontend UI (`public/index.html`)**:
  - SPA corporativa moderna em Tailwind CSS.
  - Abas: Conexão WhatsApp (QR Code), Gestão de Obras (Grupos vs Obras ativas) e Calendário Operacional (FullCalendar).
  - SweetAlert2 para confirmações e toasts.
- [x] **Módulo 3: O Despertador (`.github/workflows/wake-render.yml`)**:
  - Disparado via cron às 06:55 AM (Brasília) de segunda a sexta e 08:55 AM (segunda).
  - Executa `curl https://agenda-xpsh.onrender.com/api/wake`.
- [x] **Configuração do `package.json`**:
  - `"start": "node dist/server.js"`, `"build": "tsc"`.

---

## [Pending / Next Steps]
1. [ ] Executar `git push origin main` para acionar o deploy automático no Render.
2. [ ] O Render subirá o build, abrirá a porta HTTP e permanecerá **Healthy (Live)** sem erros de timeout ou shutdown.
3. [ ] Acessar `https://agenda-xpsh.onrender.com` pelo navegador para ver o dashboard online!

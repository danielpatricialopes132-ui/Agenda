# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`01 - Setup e Scaffolding Inicial`

---

## [Context]
O projeto acabou de ser criado. A arquitetura principal foi definida para rodar de forma efêmera no GitHub Actions (cron a cada 3 horas) com persistência completa da sessão do WhatsApp e dos dados de obra no Supabase.

---

## [Completed]
- [x] Geração da estrutura de pastas do projeto (`src/lib/`, `src/config/`, `.github/workflows/`).
- [x] Configuração do `package.json` com scripts de `build`, `start`, `dev` e dependências necessárias.
- [x] Criação do arquivo de governança global [`AGENTS.md`](file:///c:/Agenda/AGENTS.md).
- [x] Criação do diário de bordo e alinhamento [`HANDOFF.md`](file:///c:/Agenda/HANDOFF.md).

---

## [Pending / Next Steps]
1. [ ] Obter o script SQL para criar as tabelas `baileys_auth_state`, `mensagens_processadas` e `agenda_obra` no Supabase.
2. [ ] Implementar o adaptador `useSupabaseAuthState.ts` para persistência remota do Baileys com cache em memória.
3. [ ] Implementar a integração com a IA em `aiProcessor.ts` usando saída estruturada em JSON.
4. [ ] Criar o motor principal em `index.ts` e o arquivo de workflow do GitHub Actions (`.github/workflows/bot-cron.yml`).

---

## [Known Issues / Blockers]
- **Aguardando criação das tabelas no banco de dados** (executar script SQL no Supabase antes de rodar os testes de conexão).
- Necessidade de realizar o primeiro pareamento de QR Code em ambiente local para popular o `creds` inicial na tabela `baileys_auth_state`.

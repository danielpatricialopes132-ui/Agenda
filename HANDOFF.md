# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`04 - Motor Principal (src/index.ts) Concluído`

---

## [Context]
O motor principal do bot (`src/index.ts`) foi totalmente implementado e conectado aos módulos `src/lib/useSupabaseAuthState.ts` e `src/lib/aiProcessor.ts`.
A aplicação executa o ciclo completo de 60 segundos com conexão remota no Supabase, deduplicação de mensagens, extração via Gemini, gravação de agendamentos com reação 📅, disparos de relatórios periódicos e desligamento limpo (`process.exit(0)`).

---

## [Completed]
- [x] **Passo 1**: Setup inicial, criação de `package.json`, `tsconfig.json`, `AGENTS.md` e `HANDOFF.md`.
- [x] **Passo 2**: Implementação do adaptador `src/lib/useSupabaseAuthState.ts` com suporte a `BufferJSON`, cache em memória (`Map`) e persistência no Supabase.
- [x] **Passo 3**: Implementação do processador de IA em `src/lib/aiProcessor.ts` com `gemini-1.5-flash`, schema JSON e suporte à data base de referência.
- [x] **Passo 4**: Consolidação do motor principal em `src/index.ts`:
  - Inicialização do Baileys via `useSupabaseAuthState('obra_principal')`.
  - Exibição do QR Code via `qrcode-terminal` quando não autenticado.
  - Sincronização via `messages.upsert` e `messaging-history.set`.
  - Filtro exclusivo por `OBRA_GROUP_ID`.
  - Deduplicação na tabela `mensagens_processadas`.
  - Gravação na tabela `agenda_obra` e reação `📅`.
  - Motor de relatórios da obra (Segunda-feira: Agenda da Semana / Terça a Sexta: Lembretes do Dia) com controle em `disparos_executados`.
  - Graceful Shutdown aos 60s com `saveCreds()`, `sock.end()` e `process.exit(0)`.

---

## [Pending / Next Steps]
1. [ ] **Passo 5**: Validação e deploy do workflow do GitHub Actions em `.github/workflows/bot-cron.yml`.
2. [ ] Configuração dos Secrets no GitHub (`SUPABASE_URL`, `SUPABASE_KEY`, `GEMINI_API_KEY`, `OBRA_GROUP_ID`, `OBRA_ID`).
3. [ ] Criar a tabela `disparos_executados` no Supabase (se ainda não executado no SQL Editor).
4. [ ] Realizar primeira execução local com `npm start` para pareamento com QR Code inicial.

---

## [Known Issues / Blockers]
- Tabela `disparos_executados` necessita ser criada no Supabase para garantir a idempotência dos relatórios cron.

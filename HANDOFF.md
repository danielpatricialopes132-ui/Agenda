# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`03 - Processador de IA (aiProcessor.ts) Concluído`

---

## [Context]
O projeto está configurado para execução serverless no GitHub Actions. O adaptador de autenticação remota (`useSupabaseAuthState.ts`) e o processador NLP com Google Gemini (`aiProcessor.ts`) foram implementados com validação de tipos estrita e tratamento de erros.

---

## [Completed]
- [x] **Passo 1**: Setup inicial, criação de `package.json`, `tsconfig.json`, `AGENTS.md` e `HANDOFF.md`.
- [x] **Passo 2**: Implementação do adaptador `src/lib/useSupabaseAuthState.ts` com suporte a `BufferJSON`, cache em memória (`Map`) e persistência no Supabase.
- [x] **Passo 3**: Implementação do processador de IA em `src/lib/aiProcessor.ts`:
  - Utilização do SDK oficial `@google/generative-ai` com `gemini-1.5-flash`.
  - Exportação da função `extrairAgendamento(textoMensagem: string, dataAtualBase: string)`.
  - Suporte à resolução temporal dinâmica a partir de `dataAtualBase` (ex: "amanhã", "segunda que vem").
  - System prompt rigoroso focado no canteiro de obras do ecossistema GADAP Hub.
  - Interface garantida `{ is_agendamento: boolean, data_iso: string | null, horario: string | null, descricao: string | null }`.
  - Tratamento de exceções com fallback seguro retornando `is_agendamento: false`.

---

## [Pending / Next Steps]
1. [ ] **Passo 4**: Consolidar o motor principal em `src/index.ts`:
   - Conexão do Baileys via `useSupabaseAuthState`.
   - Exibição de QR Code se não autenticado.
   - Sincronização de mensagens (`messages.upsert` e `messaging-history.set`).
   - Filtro por `OBRA_GROUP_ID`.
   - Deduplicação na tabela `mensagens_processadas`.
   - Inserção na tabela `agenda_obra` e reação `📅`.
   - Rotina de relatórios (Segunda-feira semanal / Terça a Sexta diário).
   - Graceful shutdown de 60 segundos com `process.exit(0)`.
2. [ ] **Passo 5**: Finalizar o workflow do GitHub Actions em `.github/workflows/bot-cron.yml`.
3. [ ] Criar tabela `disparos_executados` no Supabase (se ainda não executado).

---

## [Known Issues / Blockers]
- Necessidade de rodar o primeiro login local (`npm start`) para scan do QR Code e persistência inicial das credenciais no Supabase.

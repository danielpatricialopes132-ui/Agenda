# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`05 - Workflow GitHub Actions e Pipeline de CI/CD Concluídos`

---

## [Context]
Todo o ciclo de engenharia de software foi concluído: persistência de autenticação do Baileys no Supabase, processamento NLP de mensagens de obra com Google Gemini, deduplicação em banco, relatórios programados (Segunda/Terça-Sexta), graceful shutdown de 60 segundos e pipeline automatizado no GitHub Actions a cada 3 horas com trava de concorrência e Quality Gates mandatórios.

---

## [Completed]
- [x] **Passo 1**: Setup inicial, criação de `package.json`, `tsconfig.json`, `AGENTS.md` e `HANDOFF.md`.
- [x] **Passo 2**: Implementação do adaptador `src/lib/useSupabaseAuthState.ts` com suporte a `BufferJSON`, cache em memória (`Map`) e persistência no Supabase.
- [x] **Passo 3**: Implementação do processador de IA em `src/lib/aiProcessor.ts` com `gemini-1.5-flash`, schema JSON e suporte à data base de referência.
- [x] **Passo 4**: Consolidação do motor principal em `src/index.ts` (deduplicação, reação `📅`, motor de relatórios periódicos e graceful shutdown aos 60s).
- [x] **Passo 5**: Finalização e validação do workflow do GitHub Actions em `.github/workflows/bot-cron.yml`:
  - Agendamento cron a cada 3 horas (`0 */3 * * *`).
  - Disparo manual habilitado (`workflow_dispatch`).
  - Trava de concorrência com `concurrency: group: gadap-whatsapp-bot`.
  - Quality Gate integrado no runner (`npx tsc --noEmit`).
  - Mapeamento das secrets de produção e fuso `TZ: 'America/Sao_Paulo'`.

---

## [Pending / Next Steps]
1. [ ] **Configuração das Secrets no GitHub**:
   Adicionar no repositório (`Settings > Secrets and variables > Actions`):
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `GEMINI_API_KEY`
   - `OBRA_GROUP_ID`
   - `OBRA_ID` (opcional, padrão `obra_principal`)
2. [ ] **Criação da tabela de controle no Supabase**:
   Executar no SQL Editor do Supabase a tabela `disparos_executados` para idempotência dos relatórios diários/semanais.
3. [ ] **Primeiro Login / Pareamento**:
   Executar `npm start` em terminal local uma única vez para escanear o QR Code impresso e persistir as credenciais na tabela `baileys_auth_state`.

---

## [Known Issues / Blockers]
- Nenhuma pendência técnica de código. Aguardando apenas configuração de Secrets e scan inicial do QR Code pelo usuário.

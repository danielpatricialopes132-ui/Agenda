# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`06 - Dashboard de Setup e Onboarding (src/setup-ui.ts) Concluído`

---

## [Context]
O assistente de obras do ecossistema GADAP Hub possui agora um **Dashboard Visual de Setup** (`src/setup-ui.ts`). Esta interface local Express + Tailwind CSS permite ao gestor ou desenvolvedor escanear o QR Code de forma amigável no navegador e obter a listagem de todos os IDs dos grupos de WhatsApp para configuração da variável `OBRA_GROUP_ID`.

---

## [Completed]
- [x] **Passo 1**: Setup inicial, criação de `package.json`, `tsconfig.json`, `AGENTS.md` e `HANDOFF.md`.
- [x] **Passo 2**: Implementação do adaptador `src/lib/useSupabaseAuthState.ts` com persistência remota no Supabase e cache em memória.
- [x] **Passo 3**: Implementação do processador de IA em `src/lib/aiProcessor.ts` com Gemini 1.5 Flash e schema JSON restrito.
- [x] **Passo 4**: Consolidação do motor principal em `src/index.ts` (deduplicação, reação `📅`, motor de relatórios periódicos e graceful shutdown aos 60s).
- [x] **Passo 5**: Workflow do GitHub Actions em `.github/workflows/bot-cron.yml` com concorrência e cron a cada 3h.
- [x] **Passo 6 (Onboarding UI)**: Implementação do arquivo `src/setup-ui.ts`:
  - Servidor Express na porta 3000 com rota principal `/` e API `/api/status`.
  - Integração Baileys via `useSupabaseAuthState` convertendo o QR Code para base64 com `qrcode.toDataURL()`.
  - Captura e listagem dos grupos participantes com `sock.groupFetchAllParticipating()`.
  - Interface moderna responsiva com Tailwind CSS, polling dinâmico a cada 2s e botão de copiar ID para clipboard.
  - Script `"setup:ui": "tsx src/setup-ui.ts"` adicionado no `package.json`.

---

## [Pending / Next Steps]
1. [ ] **Executar o Dashboard Localmente**:
   Executar `npm run setup:ui` e abrir `http://localhost:3000` para escanear o QR Code e copiar o ID do grupo de obra desejado.
2. [ ] **Configurar Secrets no GitHub**:
   Adicionar no repositório (`Settings > Secrets and variables > Actions`):
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `GEMINI_API_KEY`
   - `OBRA_GROUP_ID` (obtido no Dashboard)
   - `OBRA_ID` (opcional, padrão `obra_principal`)
3. [ ] **Criação da tabela de controle no Supabase**:
   Executar no SQL Editor do Supabase a tabela `disparos_executados` para idempotência dos relatórios diários/semanais.

---

## [Known Issues / Blockers]
- Nenhuma pendência técnica. O pareamento visual está pronto para execução pelo usuário.

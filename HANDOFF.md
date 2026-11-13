# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`02 - Implementação do Adaptador useSupabaseAuthState Concluída`

---

## [Context]
O projeto está configurado para execução serverless no GitHub Actions com banco de dados e sessão persistidos no Supabase. O adaptador customizado do Baileys foi implementado com cache em memória e suporte à serialização binária com BufferJSON.

---

## [Completed]
- [x] Geração da estrutura de pastas do projeto (`src/lib/`, `src/config/`, `.github/workflows/`).
- [x] Configuração do `package.json` com scripts de `build`, `start`, `dev` e dependências necessárias.
- [x] Criação do arquivo de governança global [`AGENTS.md`](file:///c:/Agenda/AGENTS.md).
- [x] Criação do diário de bordo [`HANDOFF.md`](file:///c:/Agenda/HANDOFF.md).
- [x] Criação das tabelas no Supabase (`baileys_auth_state` [colunas: `id` e `data`], `mensagens_processadas`, `agenda_obra`).
- [x] Implementação do adaptador `src/lib/useSupabaseAuthState.ts` com:
  - Assinatura `useSupabaseAuthState(sessionName: string)`.
  - Funções internas `readData`, `writeData` e `removeData`.
  - Reconstrução de buffers binários com `BufferJSON.reviver` e fallback para `initAuthCreds()`.
  - Serialização com `BufferJSON.replacer` e UPSERT na tabela `baileys_auth_state`.
  - Cache local em memória (`Map`) para mitigar throttling de I/O no Supabase.

---

## [Pending / Next Steps]
1. [ ] Implementar a integração com a IA em `src/lib/aiProcessor.ts` com tipagem garantida e prompt estruturado para o contexto de obras.
2. [ ] Consolidar o motor principal em `src/index.ts` (conexão, filtro por `OBRA_GROUP_ID`, deduplicação e rotina de relatórios).
3. [ ] Criar/validar o workflow do GitHub Actions em `.github/workflows/bot-cron.yml`.
4. [ ] Criar a tabela `disparos_executados` no Supabase para controle de idempotência dos relatórios diários/semanais.

---

## [Known Issues / Blockers]
- Executar a primeira inicialização local (`npm start`) para gerar o QR Code e popular as credenciais iniciais na tabela `baileys_auth_state`.

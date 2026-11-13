# HANDOFF.md - Diário de Bordo & Estado do Projeto

Documento vivo de sincronização entre o desenvolvedor humano e os agentes de IA. Atualizado a cada iteração significativa.

---

## [State]
`07 - Arquitetura Multi-Obras Dinâmica Concluída`

---

## [Context]
A arquitetura do bot de WhatsApp foi completamente evoluída de um modelo fixo (via `.env`) para um modelo dinâmico **Multi-Obras**, suportando múltiplos canteiros de obras simultâneos geridos pelo Dashboard local (`src/setup-ui.ts`) e persistidos na tabela `obras_config` do Supabase.

---

## [Completed]
- [x] **Módulo 1: Base de Dados (Supabase)**:
  - Script DDL atualizado em `supabase_schema.sql` com a tabela `obras_config` (`obra_id [PK]`, `nome_obra`, `responsaveis [TEXT[]]`, `ativa [BOOL]`, `created_at`).
  - Relacionamento de chave estrangeira em `agenda_obra` para `obras_config(obra_id)`.
  - Atualização da tabela `disparos_executados` com constraint única por `obra_id`, `tipo_disparo` e `referencia_data`.
- [x] **Módulo 2: Backend do Dashboard (`src/setup-ui.ts`)**:
  - `GET /api/obras`: Consulta todas as obras cadastradas no Supabase.
  - `POST /api/obras`: Cadastra/atualiza obras com higienização dos números dos responsáveis.
  - `DELETE /api/obras/:id`: Remove ou inativa o monitoramento de uma obra.
- [x] **Módulo 3: UX/UI do Dashboard (`src/setup-ui.ts`)**:
  - Tela dividida em duas colunas: **Grupos Disponíveis no WhatsApp** (esquerda) e **Obras Monitorizadas** (direita).
  - Botão azul **"Configurar Obra"** abrindo modal interativo em Tailwind CSS com nome da obra, JID bloqueado e textarea para múltiplos números de responsáveis.
  - Cards visuais com tags de responsáveis, status ativo e botão de remoção rápida.
- [x] **Módulo 4: Motor do Bot (`src/index.ts`)**:
  - Filtro dinâmico: o bot consulta a tabela `obras_config` via cache em memória com TTL de 2 minutos para verificar se o grupo é monitorado, eliminando dependência da variável estática `OBRA_GROUP_ID`.
  - Agrupamento de agendamentos por `obra_id`.
  - Motor de relatórios multi-obras com disparos no grupo da obra e em privado para cada telefone cadastrado em `responsaveis` (`@s.whatsapp.net`).

---

## [Pending / Next Steps]
1. [ ] **Criar a tabela `obras_config` no Supabase**:
   Executar o script DDL no SQL Editor do Supabase para criar `obras_config` e ajustar constraints.
2. [ ] **Iniciar o Dashboard e Cadastrar as Obras**:
   Executar `npm run setup:ui`, escanear o QR Code em `http://localhost:3000` e configurar os grupos de obra desejados com seus respectivos responsáveis.

---

## [Known Issues / Blockers]
- Necessário rodar o comando DDL de `obras_config` no Supabase para que a nova API e o bot persistam as configurações dinâmicas.

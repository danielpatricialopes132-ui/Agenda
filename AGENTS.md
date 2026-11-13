# AGENTS.md - Governança e Diretrizes para Agentes de IA

Este documento dita as regras globais, restrições arquiteturais e padrões de qualidade obrigatórios para qualquer agente de IA ou desenvolvedor atuando neste repositório.

---

## 1. Contexto do Projeto

O **Bot de WhatsApp da Agenda de Obras (GADAP Hub)** é uma aplicação serverless efêmera projetada para rodar exclusivamente como um **cron job no GitHub Actions** (a cada 3 horas).
O bot inicializa, restaura a sessão remota do WhatsApp, consome mensagens não lidas do grupo de obra, extrai agendamentos usando IA (NLP), salva eventos no banco de dados, dispara relatórios diários/semanais (quando na janela adequada) e realiza um **graceful shutdown** encerrando o processo (`process.exit(0)`) em até 60 segundos.

---

## 2. Stack Permitida

- **Runtime**: Node.js (v20+ LTS)
- **Linguagem**: TypeScript (Strict Mode ativado em `tsconfig.json`)
- **Engine WhatsApp**: `@whiskeysockets/baileys`
- **Banco de Dados & Auth State**: `@supabase/supabase-js` (PostgreSQL)
- **Processador de IA**: Google Gemini SDK (`@google/generative-ai`) com JSON Schema estrito
- **CI/CD & Runner**: GitHub Actions (`.github/workflows/bot-cron.yml`)

---

## 3. Regras de Arquitetura Críticas (Não Negociáveis)

> [!CAUTION]
> **PROIBIÇÃO DE PERSISTÊNCIA EM SISTEMA DE ARQUIVOS LOCAL:**
> O ambiente de execução do GitHub Actions é efêmero e destruído imediatamente após o término do workflow. É **terminantemente proibido** utilizar `useMultiFileAuthState`, arquivos `.json` locais, pastas `tmp/` ou `sqlite` para persistir sessões, credenciais ou flags de mensagens.
> **Todo o estado de autenticação (chaves criptográficas, creds, pre-keys) e deduplicação de mensagens deve obrigatoriamente trafegar via Supabase.**

1. **Estado do Baileys**: Deve utilizar o adaptador customizado `useSupabaseAuthState` gravando na tabela `baileys_auth_state` (colunas `key` e `data`), com serialização binária via `BufferJSON`.
2. **Deduplicação**: Nenhuma mensagem pode ser reenviada para a IA ou reprocessada. A tabela `mensagens_processadas` deve ser consultada antes de qualquer inferência.
3. **Idempotência de Disparos**: Relatórios diários e semanais devem registrar o envio na tabela `disparos_executados` para impedir disparos múltiplos dentro da mesma janela temporal.
4. **Graceful Shutdown Controlado**: O processo possui timeout de execução fixo em 60 segundos. O encerramento deve sempre chamar `saveCreds()`, `sock.end()` e `process.exit(0)`.

---

## 4. Quality Gates Mandatórios

Antes de dar qualquer tarefa, refatoração ou funcionalidade como concluída, o agente de IA **DEVE OBRIGATORIAMENTE** executar e validar os seguintes comandos no terminal:

1. **Verificação de Tipos do TypeScript**:
   ```bash
   npx tsc --noEmit
   ```
   *Nenhum erro de tipagem (`TS...`) é tolerado.*
2. **Build de Produção**:
   ```bash
   npm run build
   ```
   *Deve gerar os arquivos na pasta `dist/` sem advertências graves.*
3. **Linter e Testes** (quando configurados):
   ```bash
   npm run lint --if-present
   npm test --if-present
   ```

Se qualquer um desses comandos falhar, o trabalho **NÃO ESTÁ PRONTO**. Corrija os erros antes de responder ao usuário.

---

## 5. Regras de Estilo de Código e Entrega

1. **Arquivos Completos**: Sempre que criar ou atualizar um arquivo, forneça o código **completo** do arquivo de ponta a ponta. Não utilize trechos soltos, reticências (`// ... resto do código`) ou instruções vagas de substituição.
2. **Tipagem Estrita**: É terminantemente proibido o uso de `any` injustificado. Defina interfaces explícitas para retornos de IA, payloads do Supabase e eventos do Baileys.
3. **Tratamento de Erros e Logs Estruturados**: O runner executa headless no GitHub Actions. Toda operação crítica (leitura de chaves, parsing de IA, queries de banco) deve conter blocos `try/catch` com logs prefixados (`[DB]`, `[AI]`, `[WhatsApp]`, `[Relatórios]`) para que falhas nunca passem silenciosas nos logs do GitHub Actions.


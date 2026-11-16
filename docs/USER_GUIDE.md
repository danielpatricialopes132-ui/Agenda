# 📘 GADAP Hub - Manual do Usuário & Guia Operacional
> **Gestão Autônoma e Inteligente de Obras via WhatsApp**  
> *Versão:* 2.0 (Arquitetura Híbrida & IA Gemini)  
> *Público-alvo:* Engenheiros, Mestres de Obras, Encarregados e Administradores.

---

## 1. Visão Geral do Sistema

O **GADAP Hub** é um assistente invisível de Inteligência Artificial que monitora os grupos operacionais de obra no WhatsApp, detecta datas e compromissos mencionados em linguagem natural pela equipe de campo e os transforma automaticamente em um cronograma visual estruturado (Calendário e Tabela), sem exigir formulários ou comandos rígidos.

Além da captura autônoma, o sistema gera e dispara relatórios executivos diários e semanais, incluindo **Infográficos em Imagem** e **Morning Briefings narrados em Áudio (voz nativa)** diretamente no grupo da obra e no privado dos responsáveis.

```
[Conversa no WhatsApp] 
       │
       ▼
[Gemini 1.5 Flash (NLP)] ──► [Detecção de Conflitos Logísticos]
       │
       ▼
[Banco Remoto Supabase] ──► [Dashboard Web / Calendário / Tabela]
       │
       ▼
[Morning Briefings Matinais: Áudio TTS + Infográfico em Imagem]
```

---

## 2. Como Falar com o Bot no WhatsApp

A IA do GADAP Hub possui processamento semântico avançado. **Não é necessário usar comandos com barras ou códigos especiais**. Basta conversar normalmente no grupo da obra.

### Exemplos Práticos do que a IA Entende:

| O que você digita no WhatsApp | Como o Bot Interpreta | Confirmação no Grupo |
| :--- | :--- | :--- |
| *"Amanhã de manhã chega a persiana da sala."* | Calcula a data de amanhã às 08:00 com a entrega da persiana. | Reage com 📅 e envia citação confirmando o agendamento. |
| *"Concretagem do 4º pavimento reagendada para dia 25/11 às 14h."* | Registra para 25/11 às 14:00. Identifica se já existe bomba de concreto alocada no horário. | Confirma o registro e avisa se houver conflito de horário. |
| *"Sexta-feira vistoria do Corpo de Bombeiros às 10h."* | Converte a próxima sexta-feira no calendário para às 10:00. | Reage com 📅 e lista a vistoria. |
| *"Segunda às 07:30 descarga de 2 carretas de bloco com munck."* | Detecta necessidade de espaço logístico e horário de pico. | Alerta se houver outro caminhão marcado para a mesma hora. |

### Detecção Inteligente de Conflitos:
Se você agendar um evento que concorra em espaço ou horário com outro (exemplo: duas concretagens no mesmo dia ou duas carretas de grande porte no mesmo portão), o bot registrará o compromisso, reagirá com ⚠️ e enviará um **Alerta de Conflito Logístico** com uma sugestão de remanejamento.

---

## 3. Painel de Controle (Dashboard Web)

O Dashboard do GADAP Hub centraliza a visualização operacional e as configurações das obras.

### 3.1 Conexão WhatsApp (Aba 1)
- Mostra o status em tempo real da conexão (`Conectado`, `Aguardando QR Code` ou `Desconectado`).
- Para parear um novo aparelho:
  1. Acesse o WhatsApp no celular do bot.
  2. Toque em **Configurações / Opções** > **Aparelhos Conectados** > **Conectar um Aparelho**.
  3. Aponte a câmera para o QR Code exibido na tela.
  4. Após a leitura, a sessão criptográfica é salva automaticamente no Supabase.

### 3.2 Gestão de Obras (Aba 2)
- **Painel Esquerdo (Grupos Disponíveis):** Lista todos os grupos dos quais o número do bot participa no WhatsApp.
- **Painel Direito (Obras Monitorizadas):** Obras ativas cadastradas no sistema.
- **Configurar / Adicionar Obra:**
  1. Localize o grupo desejado e clique em **➕ Configurar Obra**.
  2. Defina o **Nome de Disparo (Clean Name)**.
  3. Insira os telefones dos engenheiros/responsáveis no formato internacional numérico puro (DDI + DDD + Número), separados por vírgula. Exemplo: `5511988139833, 5511978543369`.
  4. Clique em **Salvar Obra**.
- **Renomear / Editar Obra:**
  - Clique no botão **✏️ Editar** no card da obra para atualizar o Clean Name ou os contatos sem perder o histórico existente.

### 3.3 O que é o "Nome de Disparo (Clean Name)"?
Muitos grupos no WhatsApp usam emojis, códigos internos ou nomes longos (exemplo: `🏗️ GADAP | OBRA - ED. LEOPOLDO 2026 [OFICIAL]`).  
O **Clean Name** é o nome formal e limpo que você define para a obra (ex: `Obra Leopoldo`). Ele garante que os relatórios gerados e a voz da IA no áudio matinal pronunciem o nome com elegância e padrão corporativo.

### 3.4 Consulta de Agendamentos (Aba 3)
- **Dropdown de Seleção:** Escolha a obra monitorizada para carregar todos os compromissos.
- **Alternador de Visão (Toggle):**
  - **Modo Calendário:** Renderiza o calendário interativo mensal/semanal com suporte a cliques em cada evento.
  - **Modo Lista / Tabela:** Exibe a tabela organizada por ordem cronológica com data formatada, horário comercial e descrição completa da atividade.

---

## 4. Relatórios e Notificações Automáticas

O sistema opera com um agendador matinal ativado nos horários críticos da obra:

| Frequência | Horário de Disparo | Formato | Destinatários | Conteúdo |
| :--- | :--- | :--- | :--- | :--- |
| **Segunda-feira** | 07:00 às 09:00 | **Infográfico em Imagem (PNG)** | Grupo da Obra + Responsáveis Privados | Resumo de todas as entregas e vistorias previstas para os próximos 5 dias. |
| **Terça a Sexta** | 06:30 às 08:30 | **Imagem + Áudio TTS (PTT)** | Grupo da Obra + Responsáveis Privados | Infográfico do dia acompanhado de **Áudio narrado em português** com o briefing matinal de voz. |

> [!NOTE]
> O áudio do WhatsApp é gerado no formato nativo Push-To-Talk (`ptt: true`), simulando uma mensagem de voz gravada na hora pelo mestre de obras digital.

---

## 5. Trava Lógica Distribuída (Mutex) & FAQ

### Por que vejo "Modo Leitura" ou aviso de Mutex?
O WhatsApp não permite que o mesmo número conecte duas instâncias do Baileys ao mesmo tempo com as mesmas credenciais (o que causava o erro `status code: 440 - Connection Replaced`).  
Para evitar quedas, o GADAP Hub utiliza um **Lock Distribuído** no banco de dados. A instância principal na nuvem (Render) mantém o bot ativo. Se você abrir o projeto localmente para desenvolvimento ou visualização, ele subirá em **Modo Leitura**, permitindo usar o Dashboard normalmente sem derrubar a conexão de produção.

### O que fazer se o Bot não responder no grupo?
1. Verifique na **Aba 1 (Conexão)** se o status está verde (`WhatsApp Conectado`).
2. Confirme na **Aba 2 (Gestão de Obras)** se o grupo consta no painel de **Obras Monitorizadas**.
3. Certifique-se de que a mensagem enviada contém uma indicação temporal clara (ex: dia da semana, amanhã, data ou horário).

---
*GADAP Hub - Documentação Oficial do Sistema.*


import nodeHtmlToImage from 'node-html-to-image';

export interface EventoRelatorio {
  data_evento: string; // YYYY-MM-DD
  horario: string;     // HH:MM
  descricao: string;
}

/**
 * Gera um infográfico/card de alta definição em formato de Timeline
 * com design corporativo moderno (padrão GADAP Hub / SaaS).
 *
 * @param obraNome Nome da obra (ex: "Obra Leopoldo")
 * @param eventos Lista de eventos da semana ou do dia
 * @param tipo 'SEMANAL' | 'DIARIO'
 * @returns Buffer contendo a imagem PNG gerada
 */
export async function gerarImagemAgendaSemana(
  obraNome: string,
  eventos: EventoRelatorio[],
  tipo: 'SEMANAL' | 'DIARIO' = 'SEMANAL'
): Promise<Buffer> {
  const agora = new Date();
  const dataHojeFmt = agora.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const tituloHeader = tipo === 'SEMANAL' ? 'CRONOGRAMA DA SEMANA' : 'LEMBRETES DO DIA';
  const subtituloHeader = tipo === 'SEMANAL'
    ? 'Previsão de Entregas & Frentes de Serviço dos Próximos 5 Dias'
    : 'Atividades e Recebimentos de Materiais Programados para Hoje';

  // Formata os eventos para exibição na Timeline
  const eventosFormatados = eventos.map((ev) => {
    const [ano, mes, dia] = ev.data_evento.split('-');
    const dataObj = new Date(`${ev.data_evento}T12:00:00Z`);
    const diaSemana = dataObj.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).toUpperCase().replace('.', '');

    return {
      dia: `${dia}/${mes}`,
      diaSemana,
      horario: ev.horario || '08:00',
      descricao: ev.descricao,
    };
  });

  // Monta os itens HTML da timeline
  let timelineItemsHtml = '';

  if (eventosFormatados.length === 0) {
    timelineItemsHtml = `
      <div style="background: rgba(30, 41, 59, 0.5); border: 1px dashed rgba(71, 85, 105, 0.4); border-radius: 16px; padding: 40px; text-align: center; color: #94a3b8; font-size: 15px;">
        ✨ Nenhum compromisso ou entrega agendada para este período.<br/>
        <span style="font-size: 13px; color: #64748b; margin-top: 6px; display: inline-block;">Tenham todos um excelente expediente de trabalho!</span>
      </div>
    `;
  } else {
    timelineItemsHtml = eventosFormatados.map((ev, i) => `
      <div style="display: flex; align-items: flex-start; margin-bottom: 22px; position: relative;">
        <!-- Indicador de Data & Hora -->
        <div style="width: 140px; flex-shrink: 0; text-align: right; padding-right: 24px;">
          <div style="font-size: 16px; font-weight: 700; color: #38bdf8; letter-spacing: -0.3px;">${ev.dia}</div>
          <div style="font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; margin-top: 2px;">${ev.diaSemana} • ${ev.horario}</div>
        </div>

        <!-- Linha da Timeline & Nó -->
        <div style="position: relative; display: flex; flex-direction: column; align-items: center; align-self: stretch;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: #10b981; border: 3px solid #0f172a; box-shadow: 0 0 10px rgba(16, 185, 129, 0.6); z-index: 2; margin-top: 4px;"></div>
          ${i < eventosFormatados.length - 1 ? '<div style="width: 2px; flex: 1; background: linear-gradient(180deg, #10b981, rgba(56, 189, 248, 0.3)); margin-top: 2px;"></div>' : ''}
        </div>

        <!-- Card de Conteúdo do Compromisso -->
        <div style="flex: 1; margin-left: 20px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 14px; padding: 14px 18px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);">
          <div style="font-size: 15px; font-weight: 600; color: #f8fafc; line-height: 1.4;">${ev.descricao}</div>
          <div style="font-size: 11px; color: #10b981; font-weight: 500; margin-top: 6px; display: flex; align-items: center;">
            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #10b981; margin-right: 6px;"></span>
            Confirmado via IA GADAP Hub
          </div>
        </div>
      </div>
    `).join('');
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background: #090d16;
      width: 760px;
      padding: 36px;
      color: #f8fafc;
    }
  </style>
</head>
<body>
  <!-- Container Estilizado -->
  <div style="background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.9)); border: 1px solid rgba(51, 65, 85, 0.9); border-radius: 24px; padding: 32px; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5); position: relative; overflow: hidden;">

    <!-- Efeito de Luz Decorativo -->
    <div style="position: absolute; top: -80px; right: -80px; width: 220px; height: 220px; background: radial-gradient(circle, rgba(16, 185, 129, 0.25) 0%, transparent 70%); border-radius: 50%;"></div>
    <div style="position: absolute; bottom: -80px; left: -80px; width: 220px; height: 220px; background: radial-gradient(circle, rgba(56, 189, 248, 0.2) 0%, transparent 70%); border-radius: 50%;"></div>

    <!-- Header do Card -->
    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(51, 65, 85, 0.7); padding-bottom: 22px; margin-bottom: 26px;">
      <div style="display: flex; align-items: center;">
        <div style="width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #10b981, #06b6d4); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; color: #090d16; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4); margin-right: 14px;">
          G
        </div>
        <div>
          <div style="font-size: 11px; font-weight: 700; color: #10b981; letter-spacing: 1.2px; text-transform: uppercase;">GADAP HUB • GESTÃO DE OBRAS</div>
          <div style="font-size: 20px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">${obraNome.toUpperCase()}</div>
        </div>
      </div>
      <div style="text-align: right;">
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; display: inline-block;">
          ${tituloHeader}
        </div>
        <div style="font-size: 11px; color: #64748b; margin-top: 4px; font-weight: 500;">${dataHojeFmt}</div>
      </div>
    </div>

    <!-- Subtítulo -->
    <div style="margin-bottom: 24px; font-size: 13px; color: #94a3b8; font-weight: 500;">
      ${subtituloHeader}
    </div>

    <!-- Timeline de Eventos -->
    <div style="padding-left: 4px;">
      ${timelineItemsHtml}
    </div>

    <!-- Rodapé Corporativo -->
    <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(51, 65, 85, 0.6); display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #64748b;">
      <div>⚡ Sincronizado automaticamente via Inteligência Artificial</div>
      <div>GADAP Hub Autonomous Construction Suite</div>
    </div>

  </div>
</body>
</html>`;

  try {
    const imageBuffer = (await nodeHtmlToImage({
      html,
      quality: 100,
      type: 'png',
      puppeteerArgs: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    })) as Buffer;

    return imageBuffer;
  } catch (err) {
    console.error('[Report Generator] Falha ao renderizar imagem da agenda:', err);
    throw err;
  }
}


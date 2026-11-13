import * as googleTTS from 'google-tts-api';

export interface EventoDiaBriefing {
  horario: string;
  descricao: string;
}

/**
 * Constrói uma narração amigável e gera o Buffer de áudio (MP3) do
 * Morning Briefing para a equipe do canteiro de obras.
 *
 * Suporta textos longos dividindo automaticamente em blocos de até 200 caracteres,
 * baixando os áudios em paralelo e concatenando os Buffers nativamente.
 *
 * @param agendaDoDia Lista de compromissos programados para a data de hoje
 * @param nomeObra Nome da obra (ex: "Obra Leopoldo")
 * @returns Buffer contendo o áudio completo do briefing
 */
export async function gerarAudioBriefing(
  agendaDoDia: EventoDiaBriefing[],
  nomeObra: string
): Promise<Buffer> {
  const agora = new Date();
  const diaSemanaExtenso = agora.toLocaleDateString('pt-BR', { weekday: 'long' });

  // 1. Constrói o roteiro falado em tom profissional, motivador e claro
  let textoFala = `Bom dia equipe da ${nomeObra}! `;
  textoFala += `Hoje é ${diaSemanaExtenso}, e aqui está o resumo operacional das nossas frentes de trabalho. `;

  if (agendaDoDia.length === 0) {
    textoFala += `Não temos entregas pesadas nem vistorias agendadas para hoje. Mantenham o foco no cronograma das frentes em andamento e tenham um excelente dia de trabalho!`;
  } else if (agendaDoDia.length === 1) {
    const ev = agendaDoDia[0];
    const horaFmt = ev.horario ? `às ${ev.horario.replace(':', ' e ')}` : 'no início do expediente';
    textoFala += `Temos um compromisso programado: ${horaFmt}, ${ev.descricao}. Atenção ao canteiro e bom trabalho a todos!`;
  } else {
    textoFala += `Temos ${agendaDoDia.length} compromissos programados para hoje. `;
    agendaDoDia.forEach((ev, idx) => {
      const ordem = idx === 0 ? 'Primeiro' : idx === agendaDoDia.length - 1 ? 'E por fim' : 'Em seguida';
      const horaFmt = ev.horario ? `às ${ev.horario.replace(':', ' e ')}` : 'ao longo do dia';
      textoFala += `${ordem}, ${horaFmt}, teremos ${ev.descricao}. `;
    });
    textoFala += `Fiquem atentos às descargas e frentes de serviço. Um excelente dia de trabalho a todos!`;
  }

  try {
    // 2. Utiliza getAllAudioBase64 para textos longos (garante divisão limpa sem truncamento)
    const audioParts = await googleTTS.getAllAudioBase64(textoFala, {
      lang: 'pt-BR',
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000,
      splitPunct: '.,;!?',
    });

    // 3. Converte cada parte em Buffer binário e concatena em um único Buffer
    const buffers = audioParts.map((part) => Buffer.from(part.base64, 'base64'));
    const audioFinal = Buffer.concat(buffers);

    console.log(`[Audio Briefing] Áudio gerado com sucesso para "${nomeObra}" (${audioFinal.length} bytes).`);
    return audioFinal;
  } catch (err) {
    console.error(`[Audio Briefing] Falha ao sintetizar áudio para "${nomeObra}":`, err);
    throw err;
  }
}


import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey);

export interface AgendaObra {
  id?: string;
  obra_id: string;
  data_evento: string; // YYYY-MM-DD
  horario: string;     // HH:MM
  descricao: string;
  created_at?: string;
}

/**
 * Verifica se uma mensagem já foi processada anteriormente.
 */
export async function mensagemJaProcessada(messageId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('mensagens_processadas')
    .select('message_id')
    .eq('message_id', messageId)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] Erro ao checar mensagem processada:', error.message);
    return false;
  }

  return !!data;
}

/**
 * Marca uma mensagem como processada na tabela de deduplicação.
 */
export async function marcarMensagemProcessada(messageId: string, remoteJid: string): Promise<void> {
  const { error } = await supabase
    .from('mensagens_processadas')
    .insert([{ message_id: messageId, remote_jid: remoteJid }]);

  if (error && error.code !== '23505') { // ignora erro de chave duplicada
    console.error('[Supabase] Erro ao marcar mensagem como processada:', error.message);
  }
}

/**
 * Salva um novo agendamento na tabela agenda_obra.
 */
export async function salvarAgendamento(evento: Omit<AgendaObra, 'id' | 'created_at'>): Promise<AgendaObra | null> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .insert([
      {
        obra_id: evento.obra_id,
        data_evento: evento.data_evento,
        horario: evento.horario,
        descricao: evento.descricao,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('[Supabase] Erro ao salvar agendamento:', error.message);
    return null;
  }

  return data;
}

/**
 * Busca eventos em um intervalo de datas para o resumo semanal.
 */
export async function buscarEventosPorIntervalo(
  obraId: string,
  inicio: string,
  fim: string
): Promise<AgendaObra[]> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .select('*')
    .eq('obra_id', obraId)
    .gte('data_evento', inicio)
    .lte('data_evento', fim)
    .order('data_evento', { ascending: true })
    .order('horario', { ascending: true });

  if (error) {
    console.error('[Supabase] Erro ao buscar intervalo de eventos:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Busca eventos do dia para os lembretes diários.
 */
export async function buscarEventosDoDia(obraId: string, dataIso: string): Promise<AgendaObra[]> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .select('*')
    .eq('obra_id', obraId)
    .eq('data_evento', dataIso)
    .order('horario', { ascending: true });

  if (error) {
    console.error('[Supabase] Erro ao buscar eventos do dia:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Verifica se o disparo programado (SEMANAL ou DIARIO) já foi enviado hoje.
 */
export async function disparoJaRealizado(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('disparos_executados')
    .select('id')
    .eq('tipo_disparo', tipo)
    .eq('referencia_data', dataRef)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] Erro ao checar disparo já realizado:', error.message);
    return false;
  }

  return !!data;
}

/**
 * Registra o disparo como executado para evitar disparos duplicados na mesma janela.
 */
export async function registrarDisparo(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<void> {
  const { error } = await supabase
    .from('disparos_executados')
    .insert([{ tipo_disparo: tipo, referencia_data: dataRef }]);

  if (error && error.code !== '23505') {
    console.error('[Supabase] Erro ao registrar disparo:', error.message);
  }
}

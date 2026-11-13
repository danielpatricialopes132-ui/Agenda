import { supabase } from './useSupabaseAuthState';

export const LOCK_ID = 'baileys_lock';
export const LOCK_EXPIRATION_MS = 2 * 60 * 1000; // 2 minutos
export const HEARTBEAT_INTERVAL_MS = 45 * 1000; // 45 segundos

let heartbeatInterval: NodeJS.Timeout | null = null;

export interface SystemLock {
  id: string;
  locked_by: string;
  last_heartbeat: string;
}

/**
 * Tenta adquirir o lock distribuído para a instância atual.
 * Se a tabela estiver vazia, cria o registro.
 * Se o lock pertencer à mesma instância ou estiver expirado (> 2 minutos), adquire o lock.
 */
export async function acquireLock(instanceName: string): Promise<boolean> {
  const agoraIso = new Date().toISOString();

  try {
    const { data: lockRecord, error: selectError } = await supabase
      .from('system_locks')
      .select('id, locked_by, last_heartbeat')
      .eq('id', LOCK_ID)
      .maybeSingle();

    if (selectError) {
      console.warn(`[MUTEX] Aviso ao consultar system_locks: ${selectError.message}`);
      return false;
    }

    // Caso 1: Registro não existe ainda, tenta criar
    if (!lockRecord) {
      const { data: inserted, error: insertError } = await supabase
        .from('system_locks')
        .insert([{ id: LOCK_ID, locked_by: instanceName, last_heartbeat: agoraIso }])
        .select()
        .single();

      if (!insertError && inserted) {
        console.log(`🔒 [MUTEX] Lock "${LOCK_ID}" adquirido com sucesso por "${instanceName}".`);
        return true;
      }
      return false;
    }

    // Caso 2: Registro existe. Verificar se pertence à mesma instância ou se expirou
    const lastHeartbeatTime = new Date(lockRecord.last_heartbeat).getTime();
    const diferencaMs = Date.now() - lastHeartbeatTime;
    const expirou = diferencaMs > LOCK_EXPIRATION_MS;
    const mesmaInstancia = lockRecord.locked_by === instanceName;

    if (mesmaInstancia || expirou) {
      const { data: updated, error: updateError } = await supabase
        .from('system_locks')
        .update({
          locked_by: instanceName,
          last_heartbeat: agoraIso,
        })
        .eq('id', LOCK_ID)
        .select()
        .single();

      if (!updateError && updated) {
        console.log(
          `🔒 [MUTEX] Lock "${LOCK_ID}" assumido por "${instanceName}" (motivo: ${
            mesmaInstancia ? 'renovação própria' : `lock anterior expirado há ${Math.round(diferencaMs / 1000)}s`
          }).`
        );
        return true;
      }
    }

    console.warn(
      `⚠️ [MUTEX] Lock ativo retido por "${lockRecord.locked_by}" (último batimento há ${Math.round(
        diferencaMs / 1000
      )}s).`
    );
    return false;
  } catch (err: any) {
    console.error(`[MUTEX] Erro inesperado ao adquirir lock:`, err?.message || err);
    return false;
  }
}

/**
 * Inicia a rotina de batimento cardíaco (Heartbeat) da instância para renovar o lock a cada 45s.
 */
export function startHeartbeat(instanceName: string): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  heartbeatInterval = setInterval(async () => {
    try {
      const agoraIso = new Date().toISOString();
      const { error } = await supabase
        .from('system_locks')
        .update({ last_heartbeat: agoraIso })
        .eq('id', LOCK_ID)
        .eq('locked_by', instanceName);

      if (error) {
        console.warn(`[MUTEX] Falha no heartbeat para "${instanceName}": ${error.message}`);
      } else {
        // Heartbeat silencioso/sucesso
      }
    } catch (err: any) {
      console.warn(`[MUTEX] Exceção no heartbeat:`, err?.message || err);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Impede que o timer impeça o graceful shutdown do processo
  if (heartbeatInterval && typeof heartbeatInterval.unref === 'function') {
    heartbeatInterval.unref();
  }
}

/**
 * Libera explicitamente o lock ao encerrar a instância (opcional para graceful shutdown).
 */
export async function releaseLock(instanceName: string): Promise<void> {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  try {
    await supabase
      .from('system_locks')
      .update({ last_heartbeat: new Date(0).toISOString() })
      .eq('id', LOCK_ID)
      .eq('locked_by', instanceName);

    console.log(`🔓 [MUTEX] Lock "${LOCK_ID}" liberado por "${instanceName}".`);
  } catch {}
}


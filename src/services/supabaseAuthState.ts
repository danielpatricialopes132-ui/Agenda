import { AuthenticationCreds, AuthenticationState, BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { supabase } from './supabaseService';

/**
 * Implementação de Custom Auth State para o Baileys persistido no Supabase.
 * Isso permite que ambientes efêmeros/serverless (como GitHub Actions) restaurem
 * e salvem a sessão completa do WhatsApp sem depender de persistência em disco.
 */
export async function useSupabaseAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // 1. Carrega as credenciais principais ('creds') do Supabase
  const { data: credsRow, error: credsError } = await supabase
    .from('baileys_auth_state')
    .select('data')
    .eq('id', 'creds')
    .maybeSingle();

  if (credsError) {
    console.error('[Supabase Auth] Erro ao buscar creds:', credsError.message);
  }

  let creds: AuthenticationCreds;
  if (credsRow && credsRow.data) {
    try {
      // BufferJSON.reviver reconverte strings codificadas de volta para Buffers binários
      const credsString = JSON.stringify(credsRow.data);
      creds = JSON.parse(credsString, BufferJSON.reviver);
    } catch (e) {
      console.warn('[Supabase Auth] Falha ao desserializar creds existentes. Inicializando novas.');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  // 2. Retorna a estrutura AuthenticationState compatível com o Baileys
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [key: string]: any } = {};
          if (ids.length === 0) return data;

          const dbKeys = ids.map((id) => `${type}-${id}`);
          const { data: rows, error } = await supabase
            .from('baileys_auth_state')
            .select('id, data')
            .in('id', dbKeys);

          if (error) {
            console.error(`[Supabase Auth] Erro ao buscar chaves do tipo ${type}:`, error.message);
            return data;
          }

          for (const row of rows || []) {
            try {
              const parsed = JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
              // Remove o prefixo do id para devolver no mapa original
              const originalId = row.id.replace(`${type}-`, '');
              data[originalId] = parsed;
            } catch (err) {
              console.error(`[Supabase Auth] Erro ao converter chave ${row.id}:`, err);
            }
          }

          return data;
        },
        set: async (data) => {
          const upsertPayload: { id: string; data: any; updated_at: string }[] = [];
          const deleteKeys: string[] = [];
          const now = new Date().toISOString();

          const dataMap = data as Record<string, Record<string, any>>;
          for (const category in dataMap) {
            for (const id in dataMap[category]) {
              const value = dataMap[category][id];
              const key = `${category}-${id}`;

              if (value) {
                // BufferJSON.replacer converte Buffers binários em objetos serializáveis com segurança
                const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                upsertPayload.push({
                  id: key,
                  data: serialized,
                  updated_at: now,
                });
              } else {
                deleteKeys.push(key);
              }
            }
          }

          // Executa upserts em lote
          if (upsertPayload.length > 0) {
            const { error: upsertErr } = await supabase
              .from('baileys_auth_state')
              .upsert(upsertPayload, { onConflict: 'id' });

            if (upsertErr) {
              console.error('[Supabase Auth] Erro ao realizar upsert de chaves:', upsertErr.message);
            }
          }

          // Executa deleções em lote
          if (deleteKeys.length > 0) {
            const { error: delErr } = await supabase
              .from('baileys_auth_state')
              .delete()
              .in('id', deleteKeys);

            if (delErr) {
              console.error('[Supabase Auth] Erro ao deletar chaves:', delErr.message);
            }
          }
        },
      },
    },
    // Função chamada pelo Baileys no evento 'creds.update'
    saveCreds: async () => {
      try {
        const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
        const { error } = await supabase
          .from('baileys_auth_state')
          .upsert(
            [
              {
                id: 'creds',
                data: serializedCreds,
                updated_at: new Date().toISOString(),
              },
            ],
            { onConflict: 'id' }
          );

        if (error) {
          console.error('[Supabase Auth] Erro ao salvar creds no Supabase:', error.message);
        }
      } catch (err) {
        console.error('[Supabase Auth] Exceção ao serializar/salvar creds:', err);
      }
    },
  };
}

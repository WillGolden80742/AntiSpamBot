// Módulos: alfabetos (línguas) + semantico (links suspeitos, 0 IA) + regras (texto)
// + whitelist (links/assuntos perdoados).
// semantico: julgamento instantâneo por mensagem + Disparar (últimos 61min).
// Níveis: baixo=só registra · médio/severo=deleta+warn (até max_warns, NUNCA direto).
// Tolerância: prob. mínima do modelo p/ entrar na escada de warn (65%). Ban só após warns.
export const DEFAULT_SETTINGS = {
  alfabetos: {
    arabe: 'desativado', cirilico: 'desativado', chines: 'desativado', latim: 'desativado', hindi: 'desativado', bengali: 'desativado',
    nao_ocidental: 'desativado',
    exceto_nao_ocidental: [],
    progressivo_enabled: true,
    max_warns: 3,
    acao_final: 'ban',
    avisar_no_grupo: true,
    log_no_admin_grupo: true,
    admin_grupo_id: '',
    punir_staff: false,
  },
  semantico: {
    enabled: false,
    deletar: true,
    warn: true,
    avisar_no_grupo: true,
    max_warns: 3,
    acao_final: 'mute',
    log_no_admin_grupo: true,
    punir_staff: false,
    tolerancia: 65,
    regex: true,
  },
  regras: {
    texto: '1. Proibido spam, flood e divulgação sem autorização.\n2. Proibido links suspeitos (apostas, pirâmide, phishing).\n3. Respeite o tema do grupo.',
  },
  whitelist: {
    links: [],
    assuntos: [],
  },
};

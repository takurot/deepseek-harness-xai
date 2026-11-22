/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '加载技能',
  'row.running': '正在加载 skill',
  'row.preparing': '准备加载技能',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'preview.failure': '无法打开技能预览。',
  'preview.retry': '重试',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.running': 'Loading skill',
  'row.preparing': 'Preparing to load a skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'preview.failure': 'Could not open the skill preview.',
  'preview.retry': 'Retry',
} satisfies Record<SkillKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'row.title': 'スキル',
  'row.running': 'スキルを読み込み中',
  'row.preparing': 'スキルの読み込みを準備中',
  'row.failed': 'スキルの読み込みに失敗しました',
  'row.stopped': 'スキルの読み込みが停止しました',
  'row.instructions': '手順',
  'row.inspect': '詳細を確認',
  'menu.userOnly': 'ユーザー専用',
  'preview.failure': 'スキルのプレビューを開けませんでした。',
  'preview.retry': '再試行',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'row.title': 'Habilidad',
  'row.running': 'Habilidad de carga',
  'row.preparing': 'Preparándose para cargar una habilidad',
  'row.failed': 'La carga de habilidades falló',
  'row.stopped': 'Carga de habilidades detenida',
  'row.instructions': 'Instrucciones',
  'row.inspect': 'inspeccionar',
  'menu.userOnly': 'solo usuario',
  'preview.failure': 'No se pudo abrir la vista previa de la habilidad.',
  'preview.retry': 'Reintentar',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'row.title': 'Compétence',
  'row.running': 'Compétence de chargement',
  'row.preparing': 'Préparation du chargement d’une compétence',
  'row.failed': 'Échec du chargement des compétences',
  'row.stopped': 'Chargement de compétences arrêté',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspecter',
  'menu.userOnly': 'utilisateur uniquement',
  'preview.failure': 'Impossible d’ouvrir l’aperçu de la compétence.',
  'preview.retry': 'Réessayer',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'row.title': 'Geschicklichkeit',
  'row.running': 'Ladefähigkeit',
  'row.preparing': 'Das Laden eines Skills wird vorbereitet',
  'row.failed': 'Das Laden des Skills ist fehlgeschlagen',
  'row.stopped': 'Das Laden der Fertigkeiten wurde gestoppt',
  'row.instructions': 'Anweisungen',
  'row.inspect': 'Inspizieren',
  'menu.userOnly': 'Nur für Benutzer',
  'preview.failure': 'Die Skill-Vorschau konnte nicht geöffnet werden.',
  'preview.retry': 'Erneut versuchen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'row.title': 'Навык',
  'row.running': 'Навык загрузки',
  'row.preparing': 'Подготовка к загрузке навыка',
  'row.failed': 'Не удалось загрузить навык',
  'row.stopped': 'Загрузка навыков остановлена',
  'row.instructions': 'Инструкции',
  'row.inspect': 'Осмотреть',
  'menu.userOnly': 'только для пользователей',
  'preview.failure': 'Не удалось открыть предпросмотр навыка.',
  'preview.retry': 'Повторить',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'row.title': 'Habilidade',
  'row.running': 'Habilidade de carregamento',
  'row.preparing': 'Preparando-se para carregar uma habilidade',
  'row.failed': 'Falha no carregamento da habilidade',
  'row.stopped': 'Carga de habilidade interrompida',
  'row.instructions': 'Instruções',
  'row.inspect': 'Inspecionar',
  'menu.userOnly': 'somente usuário',
  'preview.failure': 'Não foi possível abrir a pré-visualização da habilidade.',
  'preview.retry': 'Tentar novamente',
} satisfies Record<keyof typeof en, string>

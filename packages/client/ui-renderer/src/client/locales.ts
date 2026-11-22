/**
 * `renderer` dictionaries for the top-level render-failure fallback. The
 * fallback must render without the slot tree, so it binds this namespace
 * directly from the installed locale face and falls back to the English
 * dictionary when no face is installed (boot-order failure) or the face
 * cannot resolve the key.
 *
 * @module @deepseek-ai/dsh-client-ui-renderer/src/client/locales
 */
import type { LocaleFace, Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this package's render-failure fallback. */
export const NS = 'renderer'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'title': '界面已停止渲染',
  'body': '浏览器在绘制此页面时，某个组件崩溃了。会话仍保存在本地服务器上，重新加载页面不会删除会话。',
  'distinction': '这是浏览器的渲染失败，而不是服务器连接断开。本地服务器仍在运行，重新加载页面无需重启服务器。',
  'reload': '重新加载',
  'diagnostics.summary': '诊断详情',
  'diagnostics.description': '保存在此浏览器中的最近渲染失败（最新在前）。',
  'diagnostics.empty': '未保存此故障的诊断信息（浏览器存储可能不可用）。',
  'diagnostics.retention': '最近三次失败会保留在此浏览器中，直到被更新的失败替换。',
  'diagnostics.privacy': '保存内容：时间、错误类型、消息、堆栈和插槽。不保存：提示词、会话正文、凭据或组件属性。',
  'diagnostics.copy': '复制诊断信息',
  'diagnostics.copied': '已复制。',
  'diagnostics.copyFailed': '复制失败。请选择上方文本并手动复制。',
  'diagnostics.time': '时间：{value}',
  'diagnostics.slot': '插槽：{value}',
  'diagnostics.error': '错误：{value}',
  'diagnostics.message': '消息：{value}',
  'diagnostics.stack': '堆栈：\n{value}',
} satisfies Record<string, string>

/** Renderer dictionary key union. */
export type RendererKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the top-level render-failure fallback. */
    renderer: RendererKey
  }
}

/** English dictionary, checked against the Chinese key set. */
export const en = {
  title: 'The interface stopped rendering',
  body: 'A component crashed while the browser was drawing this page. Your sessions are still on the local server, and reloading the page does not delete them.',
  distinction: 'This is a rendering failure in the browser, not a server disconnect. The local server keeps running, and reloading the page does not restart it.',
  reload: 'Reload',
  'diagnostics.summary': 'Diagnostic details',
  'diagnostics.description': 'The most recent render failures stored in this browser, newest first.',
  'diagnostics.empty': 'No diagnostic was stored for this failure (browser storage may be unavailable).',
  'diagnostics.retention': 'The last three failures stay in this browser until newer ones replace them.',
  'diagnostics.privacy': 'Stored: the time, error type, message, stack, and slot. Not stored: prompts, conversation text, credentials, or component props.',
  'diagnostics.copy': 'Copy diagnostics',
  'diagnostics.copied': 'Copied.',
  'diagnostics.copyFailed': 'Copy failed. Select the text above and copy it manually.',
  'diagnostics.time': 'Time: {value}',
  'diagnostics.slot': 'Slot: {value}',
  'diagnostics.error': 'Error: {value}',
  'diagnostics.message': 'Message: {value}',
  'diagnostics.stack': 'Stack:\n{value}',
} satisfies Record<RendererKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': '画面の描画を続けられませんでした',
  'body': 'ブラウザがこのページを描画している途中でコンポーネントがクラッシュしました。セッションはローカルサーバーに残っており、ページを再読み込みしても削除されません。',
  'distinction': 'これはブラウザ側の描画エラーであり、サーバーとの切断ではありません。ローカルサーバーは稼働したままで、再読み込みしても再起動されません。',
  'reload': '再読み込み',
  'diagnostics.summary': '診断情報の詳細',
  'diagnostics.description': 'このブラウザに保存された直近の描画エラーです（新しい順）。',
  'diagnostics.empty': 'この障害の診断情報は保存されていません（ブラウザのストレージが利用できない可能性があります）。',
  'diagnostics.retention': '直近 3 件の障害は、より新しい障害で置き換えられるまでこのブラウザに残ります。',
  'diagnostics.privacy': '保存される情報: 時刻、エラーの種類、メッセージ、スタック、スロット。保存されない情報: プロンプト、会話本文、認証情報、コンポーネントのプロパティ。',
  'diagnostics.copy': '診断情報をコピー',
  'diagnostics.copied': 'コピーしました。',
  'diagnostics.copyFailed': 'コピーできませんでした。上のテキストを選択して手動でコピーしてください。',
  'diagnostics.time': '時刻: {value}',
  'diagnostics.slot': 'スロット: {value}',
  'diagnostics.error': 'エラー: {value}',
  'diagnostics.message': 'メッセージ: {value}',
  'diagnostics.stack': 'スタック:\n{value}',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'La interfaz dejó de dibujarse',
  body: 'Un componente falló mientras el navegador dibujaba esta página. Tus sesiones siguen en el servidor local y recargar la página no las elimina.',
  distinction: 'Es un fallo de dibujo en el navegador, no una desconexión del servidor. El servidor local sigue en marcha y recargar la página no lo reinicia.',
  reload: 'Recargar',
  'diagnostics.summary': 'Detalles de diagnóstico',
  'diagnostics.description': 'Los fallos de dibujo más recientes guardados en este navegador, del más nuevo al más antiguo.',
  'diagnostics.empty': 'No se guardó ningún diagnóstico de este fallo (el almacenamiento del navegador puede no estar disponible).',
  'diagnostics.retention': 'Los tres últimos fallos permanecen en este navegador hasta que otros más nuevos los reemplacen.',
  'diagnostics.privacy': 'Se guardan: la hora, el tipo de error, el mensaje, la pila y el slot. No se guardan: indicaciones, texto de la conversación, credenciales ni propiedades de componentes.',
  'diagnostics.copy': 'Copiar diagnóstico',
  'diagnostics.copied': 'Copiado.',
  'diagnostics.copyFailed': 'No se pudo copiar. Selecciona el texto de arriba y cópialo manualmente.',
  'diagnostics.time': 'Hora: {value}',
  'diagnostics.slot': 'Slot: {value}',
  'diagnostics.error': 'Error: {value}',
  'diagnostics.message': 'Mensaje: {value}',
  'diagnostics.stack': 'Pila:\n{value}',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: "L'interface a cessé de s'afficher",
  body: 'Un composant a planté pendant que le navigateur dessinait cette page. Vos sessions restent sur le serveur local et recharger la page ne les supprime pas.',
  distinction: "Il s'agit d'une erreur d'affichage dans le navigateur, pas d'une déconnexion du serveur. Le serveur local continue de fonctionner et recharger la page ne le redémarre pas.",
  reload: 'Recharger',
  'diagnostics.summary': 'Détails du diagnostic',
  'diagnostics.description': "Les erreurs d'affichage les plus récentes enregistrées dans ce navigateur, de la plus récente à la plus ancienne.",
  'diagnostics.empty': "Aucun diagnostic n'a été enregistré pour cette panne (le stockage du navigateur est peut-être indisponible).",
  'diagnostics.retention': 'Les trois dernières pannes restent dans ce navigateur jusqu’à ce que de plus récentes les remplacent.',
  'diagnostics.privacy': "Enregistrés : l'heure, le type d'erreur, le message, la pile et le slot. Non enregistrés : les invites, le texte de la conversation, les identifiants ou les propriétés des composants.",
  'diagnostics.copy': 'Copier le diagnostic',
  'diagnostics.copied': 'Copié.',
  'diagnostics.copyFailed': 'La copie a échoué. Sélectionnez le texte ci-dessus et copiez-le manuellement.',
  'diagnostics.time': 'Heure : {value}',
  'diagnostics.slot': 'Slot : {value}',
  'diagnostics.error': 'Erreur : {value}',
  'diagnostics.message': 'Message : {value}',
  'diagnostics.stack': 'Pile :\n{value}',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Die Oberfläche wurde nicht mehr gezeichnet',
  body: 'Eine Komponente ist abgestürzt, während der Browser diese Seite gezeichnet hat. Deine Sitzungen bleiben auf dem lokalen Server; ein Neuladen der Seite löscht sie nicht.',
  distinction: 'Das ist ein Zeichenfehler im Browser, keine Trennung vom Server. Der lokale Server läuft weiter, und ein Neuladen der Seite startet ihn nicht neu.',
  reload: 'Neu laden',
  'diagnostics.summary': 'Diagnosedetails',
  'diagnostics.description': 'Die zuletzt in diesem Browser gespeicherten Zeichenfehler, neueste zuerst.',
  'diagnostics.empty': 'Für diesen Fehler wurde keine Diagnose gespeichert (Browserspeicher ist möglicherweise nicht verfügbar).',
  'diagnostics.retention': 'Die letzten drei Fehler bleiben in diesem Browser, bis neuere sie ersetzen.',
  'diagnostics.privacy': 'Gespeichert: Zeit, Fehlertyp, Meldung, Aufrufliste und Slot. Nicht gespeichert: Eingabeaufforderungen, Gesprächstext, Anmeldedaten oder Komponenteneigenschaften.',
  'diagnostics.copy': 'Diagnose kopieren',
  'diagnostics.copied': 'Kopiert.',
  'diagnostics.copyFailed': 'Kopieren fehlgeschlagen. Wähle den Text oben aus und kopiere ihn von Hand.',
  'diagnostics.time': 'Zeit: {value}',
  'diagnostics.slot': 'Slot: {value}',
  'diagnostics.error': 'Fehler: {value}',
  'diagnostics.message': 'Meldung: {value}',
  'diagnostics.stack': 'Aufrufliste:\n{value}',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Интерфейс перестал отрисовываться',
  body: 'Во время отрисовки этой страницы в браузере произошёл сбой компонента. Сеансы остаются на локальном сервере, и перезагрузка страницы их не удаляет.',
  distinction: 'Это сбой отрисовки в браузере, а не отключение от сервера. Локальный сервер продолжает работать, и перезагрузка страницы его не перезапускает.',
  reload: 'Перезагрузить',
  'diagnostics.summary': 'Подробности диагностики',
  'diagnostics.description': 'Последние сбои отрисовки, сохранённые в этом браузере, от новых к старым.',
  'diagnostics.empty': 'Для этого сбоя диагностика не сохранена (хранилище браузера может быть недоступно).',
  'diagnostics.retention': 'Последние три сбоя остаются в этом браузере, пока их не заменят более новые.',
  'diagnostics.privacy': 'Сохраняются: время, тип ошибки, сообщение, стек и слот. Не сохраняются: запросы, текст беседы, учётные данные и свойства компонентов.',
  'diagnostics.copy': 'Копировать диагностику',
  'diagnostics.copied': 'Скопировано.',
  'diagnostics.copyFailed': 'Не удалось скопировать. Выделите текст выше и скопируйте его вручную.',
  'diagnostics.time': 'Время: {value}',
  'diagnostics.slot': 'Слот: {value}',
  'diagnostics.error': 'Ошибка: {value}',
  'diagnostics.message': 'Сообщение: {value}',
  'diagnostics.stack': 'Стек:\n{value}',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'A interface parou de renderizar',
  body: 'Um componente falhou enquanto o navegador desenhava esta página. As suas sessões continuam no servidor local, e recarregar a página não as apaga.',
  distinction: 'É uma falha de renderização no navegador, não uma desconexão do servidor. O servidor local continua em execução, e recarregar a página não o reinicia.',
  reload: 'Recarregar',
  'diagnostics.summary': 'Detalhes do diagnóstico',
  'diagnostics.description': 'As falhas de renderização mais recentes guardadas neste navegador, das mais novas para as mais antigas.',
  'diagnostics.empty': 'Nenhum diagnóstico foi guardado para esta falha (o armazenamento do navegador pode estar indisponível).',
  'diagnostics.retention': 'As três últimas falhas permanecem neste navegador até serem substituídas por falhas mais recentes.',
  'diagnostics.privacy': 'Guardados: a hora, o tipo de erro, a mensagem, a pilha e o slot. Não guardados: prompts, texto da conversa, credenciais ou propriedades de componentes.',
  'diagnostics.copy': 'Copiar diagnóstico',
  'diagnostics.copied': 'Copiado.',
  'diagnostics.copyFailed': 'Não foi possível copiar. Selecione o texto acima e copie-o manualmente.',
  'diagnostics.time': 'Hora: {value}',
  'diagnostics.slot': 'Slot: {value}',
  'diagnostics.error': 'Erro: {value}',
  'diagnostics.message': 'Mensagem: {value}',
  'diagnostics.stack': 'Pilha:\n{value}',
} satisfies Record<keyof typeof en, string>

/** Complete dictionary set registered with the locale service. */
export const RENDERER_DICTIONARIES = { zh, en, ja, es, fr, de, ru, pt } as const

/** Interpolate `{name}` placeholders in one dictionary template. */
function interpolate(template: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** English dictionary ladder used when no locale face can resolve a key. */
function englishFallback(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key]
  return template === undefined ? key : interpolate(template, params)
}

/**
 * Build the fallback's translate function. The installed locale face is
 * consulted first; without one (or when it throws, or its lookup misses and
 * returns the key), the English dictionary answers, and an unknown key renders
 * as the key itself. This ladder never depends on the slot tree.
 * @param face - installed locale face, or undefined before the locale plugin activates.
 * @returns a translate function over the `renderer` namespace.
 */
export function renderFailureTranslate(face: LocaleFace | undefined): Translate {
  if (face === undefined) return englishFallback
  let bound: Translate
  try {
    bound = face.bind(NS)
  } catch (error) {
    console.error('renderer: locale face could not bind its namespace; using English copy:', error)
    return englishFallback
  }
  return (key, params) => {
    let translated: string | undefined
    try {
      translated = bound(key, params)
    } catch (error) {
      console.error('renderer: locale lookup failed; using English copy:', error)
      translated = undefined
    }
    if (translated !== undefined && translated !== key) return translated
    return englishFallback(key, params)
  }
}

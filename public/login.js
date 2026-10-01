// Сервер после неудачи редиректит на /login?e=1 (неверный логин/пароль) или
// /login?e=2 (исчерпан лимит попыток) — показываем нужное сообщение.
const e = new URLSearchParams(location.search).get('e');
if (e === '1') document.getElementById('err').hidden = false;
if (e === '2') document.getElementById('err-limit').hidden = false;

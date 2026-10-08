(() => {
  const password = document.getElementById('lgPwd');
  const toggle = document.getElementById('lgPwdToggle');
  if (!password || !toggle) return;

  toggle.addEventListener('click', () => {
    const showPassword = password.type === 'password';
    password.type = showPassword ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(showPassword));
    toggle.setAttribute('aria-label', showPassword ? '隐藏密码' : '显示密码');
    toggle.title = showPassword ? '隐藏密码' : '显示密码';
    password.focus();
  });
})();
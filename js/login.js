(function () {
  "use strict";
  var form = document.getElementById("loginForm");
  var email = document.getElementById("loginEmail");
  var pass = document.getElementById("loginPassword");
  var btn = document.getElementById("loginSubmit");
  var errBox = document.getElementById("loginError");
  var eye = document.getElementById("loginEye");

  function showError(msg, field) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    email.removeAttribute("aria-invalid");
    pass.removeAttribute("aria-invalid");
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }
  function clearError() {
    errBox.classList.add("hidden");
    errBox.textContent = "";
    email.removeAttribute("aria-invalid");
    pass.removeAttribute("aria-invalid");
  }

  eye.addEventListener("click", function () {
    var show = pass.type === "password";
    pass.type = show ? "text" : "password";
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    pass.focus();
  });

  [email, pass].forEach(function (el) {
    el.addEventListener("input", clearError);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    var em = email.value.trim();
    if (!em) return showError("Informe seu e-mail.", email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))
      return showError("Informe um e-mail válido.", email);
    if (!pass.value) return showError("Informe sua senha.", pass);

    btn.classList.add("loading");
    btn.disabled = true;
    fetch("/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: em, password: pass.value }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (d) {
            if (!r.ok) throw new Error(d.error || "Falha ao entrar.");
            window.location.replace(d.redirect || "/");
          });
      })
      .catch(function (err) {
        btn.classList.remove("loading");
        btn.disabled = false;
        showError(err.message || "Falha ao entrar.");
        pass.select();
      });
  });
})();

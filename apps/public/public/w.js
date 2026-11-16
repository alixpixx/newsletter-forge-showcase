/**
 * Loader du widget d'inscription newsletter-forge.
 * Usage (à coller sur le site) :
 *   <script src="https://VOTRE-DOMAINE/w.js" data-asset="northwind-sports"></script>
 * Injecte une iframe isolée (branding + form servis par notre domaine) et ajuste sa hauteur.
 */
(function () {
  var s = document.currentScript;
  if (!s) return;
  var asset = s.getAttribute("data-asset");
  if (!asset) return;
  var origin = new URL(s.src).origin;

  var iframe = document.createElement("iframe");
  iframe.src = origin + "/embed/" + encodeURIComponent(asset);
  iframe.title = "Inscription newsletter";
  iframe.setAttribute("scrolling", "no");
  iframe.style.width = "100%";
  iframe.style.border = "0";
  iframe.style.height = "360px";
  iframe.style.overflow = "hidden";
  s.parentNode.insertBefore(iframe, s.nextSibling);

  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== "nf-embed-height") return;
    if (typeof e.data.height === "number") iframe.style.height = e.data.height + 4 + "px";
  });
})();

const RELEASE_API =
  "https://api.github.com/repos/Maheidem/openstyle/releases/latest";
const FALLBACK_URL = "https://github.com/Maheidem/openstyle/releases/latest";

function loadRelease() {
  const downloads = document.querySelectorAll("[data-download]");
  const versionEl = document.querySelector("[data-version]");

  function fallback() {
    downloads.forEach((el) => {
      el.href = FALLBACK_URL;
    });
    if (versionEl) {
      versionEl.parentElement.hidden = true;
    }
  }

  fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
    .then((res) => {
      if (!res.ok) {
        throw new Error("release lookup failed");
      }
      return res.json();
    })
    .then((data) => {
      const dmg = (data.assets ?? []).find((asset) =>
        asset.name.endsWith(".dmg"),
      );
      if (!dmg?.browser_download_url) {
        throw new Error("no dmg asset");
      }
      downloads.forEach((el) => {
        el.href = dmg.browser_download_url;
      });
      if (versionEl && data.tag_name) {
        versionEl.textContent = `Version ${data.tag_name}`;
      }
    })
    .catch(fallback);
}

loadRelease();

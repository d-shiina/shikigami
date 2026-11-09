// Fills in the links to the repository and the latest installer.
//
// The site is published at https://spellsheet.github.io/ by the
// spellsheet/spellsheet.github.io repository. The latest release comes from
// release.json, written when the site is published, and is then checked
// against the GitHub API; either may fail (for example the API's limit of 60
// requests an hour per address), and the links then still lead to the
// release page.
(function () {
  "use strict";

  var INSTALLER = /_x64-setup\.exe$/;

  var repo = { owner: "spellsheet", repo: "spellsheet" };
  var base = "https://github.com/" + repo.owner + "/" + repo.repo;

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  all("[data-gh]").forEach(function (a) {
    a.href = base + a.getAttribute("data-gh");
  });
  all("[data-dl], [data-release]").forEach(function (a) {
    a.href = base + "/releases/latest";
  });

  function text(selector, value) {
    all(selector).forEach(function (el) {
      el.textContent = value;
      el.hidden = false;
    });
  }

  function show(selector) {
    all(selector).forEach(function (el) {
      el.hidden = false;
    });
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  var shown = null;

  function apply(release) {
    if (!release || !release.tag || !release.asset || !INSTALLER.test(release.asset.name)) return;
    if (shown && compare(release.tag, shown) <= 0) return;
    shown = release.tag;
    var version = release.tag.replace(/^v/, "");
    var mb = Math.round(release.asset.size / 1048576);

    text("[data-version]", version);
    show("[data-version-line]");
    text("[data-version-text]", "版 " + version);
    text("[data-version-plain]", version);
    if (release.published) text("[data-date]", formatDate(release.published) + " リリース");
    if (mb) {
      text("[data-size]", "約 " + mb + " MB");
      text("[data-size-mb]", String(mb));
    }
    text("[data-file]", release.asset.name);
    show("[data-file-line]");
    var sha = (release.asset.digest || "").replace(/^sha256:/, "");
    if (/^[0-9a-f]{64}$/i.test(sha)) {
      text("[data-sha]", sha.toUpperCase());
      show("[data-sha-line]");
    }
    all("[data-dl]").forEach(function (a) {
      a.href = release.asset.url;
    });
    all("[data-release]").forEach(function (a) {
      a.href = base + "/releases/tag/" + encodeURIComponent(release.tag);
    });
  }

  // "v0.1.18" against "v0.1.9", number by number.
  function compare(a, b) {
    var x = a.replace(/^v/, "").split(/[.-]/);
    var y = b.replace(/^v/, "").split(/[.-]/);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var p = parseInt(x[i] || "0", 10);
      var q = parseInt(y[i] || "0", 10);
      if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  function fromApi(json) {
    var asset = (json.assets || []).filter(function (a) {
      return INSTALLER.test(a.name);
    })[0];
    if (!asset) return null;
    return {
      tag: json.tag_name,
      published: json.published_at,
      asset: { name: asset.name, size: asset.size, url: asset.browser_download_url, digest: asset.digest },
    };
  }

  function get(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  if (!window.fetch) return;
  get("release.json")
    .then(apply)
    .catch(function () {})
    .then(function () {
      return get("https://api.github.com/repos/" + repo.owner + "/" + repo.repo + "/releases/latest");
    })
    .then(function (json) {
      apply(fromApi(json));
    })
    .catch(function () {});
})();


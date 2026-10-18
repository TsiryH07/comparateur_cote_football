(() => {
  "use strict";

  // Prépare la page et ses boutons.
  function start() {
    const byId = (id) => document.getElementById(id);
    const ui = {
      overview: byId("overview-view"), historyView: byId("history-view"),
      title: byId("page-title"), description: byId("page-description"),
      collect: byId("collect-button"), emptyCollect: byId("empty-collect"),
      lastUpdated: byId("last-updated"), connection: byId("connection-label"),
      matchesStat: byId("stats-matches"), sourcesStat: byId("stats-sources"),
      alertsStat: byId("stats-alerts"), matchedStat: byId("stats-matched"),
      settingsForm: byId("threshold-form"), thresholdValue: byId("threshold-value"),
      thresholdMode: byId("threshold-mode"), automatic: byId("automatic-toggle"),
      save: byId("settings-save"), thresholdHelp: byId("threshold-help"), nextCollection: byId("next-collection"),
      search: byId("match-search"), competition: byId("competition-filter"), onlyAlerts: byId("only-alerts"),
      matchCount: byId("match-count"), matchesBody: byId("matches-body"), matchesEmpty: byId("matches-empty"),
      alertsList: byId("alerts-list"), alertsCount: byId("alerts-count"), sourcesList: byId("sources-list"),
      diagnostics: byId("diagnostics"), diagnosticsSummary: byId("diagnostics-summary"), diagnosticsList: byId("diagnostics-list"),
      historyLimit: byId("history-limit"), historySearch: byId("history-search"), historyRefresh: byId("history-refresh"),
      historyBody: byId("history-body"), historyEmpty: byId("history-empty"), toast: byId("toast"),
      dataModeLabel: byId("data-mode-label"), dataModeDescription: byId("data-mode-description"),
      sourcesSubtitle: byId("sources-subtitle"), sourcesStatLabel: byId("sources-stat-label"),
      sourcesKind: byId("sources-kind"), sourcesNote: byId("sources-note"),
      footerDataMode: byId("footer-data-mode"), comparisonNote: byId("comparison-note"),
      serviceNotice: byId("service-notice"), serviceMessage: byId("service-message"),
      retry: byId("service-retry"),
    };
    const navigation = [...document.querySelectorAll("[data-view]")];
    const oddsFormat = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const numberFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 6 });
    const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    const outcomes = ["1", "X", "2"];
    const sourceColors = ["#67bda8", "#b3a2df", "#dfad76", "#7aaed8", "#d48ca3", "#a7bc70"];
    const secondRealSourceMessage = "Les écarts seront calculés lorsqu’une deuxième source réelle sera connectée.";
    let state = null;
    let history = [];
    let historyLoaded = false;
    let view = "overview";
    let settingsDirty = false;
    let collecting = false;
    let saving = false;
    let loadingState = false;
    let loadingHistory = false;
    let stateRevision = 0;
    let historyRevision = 0;
    let toastTimer;
    const failures = new Map();
    let lastConfirmedAt = null;

    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
    const odds = (value) => object(value) && outcomes.every((outcome) => typeof value[outcome] === "number" &&
      Number.isFinite(value[outcome]) && value[outcome] > 1);
    const match = (value) => object(value) && ["homeTeam", "awayTeam", "competition", "source", "sourceMatchId"].every((key) => nonempty(value[key])) &&
      date(value.startsAt) && date(value.collectedAt) && odds(value.odds);
    const alert = (value) => object(value) && ["eventId", "homeTeam", "awayTeam", "competition", "minSource", "maxSource"].every((key) => nonempty(value[key])) &&
      outcomes.includes(value.outcome) && date(value.startsAt) &&
      ["minOdd", "maxOdd", "absoluteDifference", "percentageDifference"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key])) &&
      value.minOdd > 1 && value.maxOdd >= value.minOdd && value.absoluteDifference >= 0 && value.percentageDifference >= 0;
    const threshold = (value) => object(value) && ["absolute", "percentage"].includes(value.mode) &&
      typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0;
    // Vérifie toutes les données reçues du service.
    function validState(value) {
      if (!object(value) || !["mock", "odds-api"].includes(value.dataSource) || !object(value.settings) ||
          !threshold(value.settings.threshold) || typeof value.settings.automatic !== "boolean" ||
          !Number.isFinite(value.settings.intervalMinutes) || value.settings.intervalMinutes <= 0 ||
          !Array.isArray(value.sources) || !value.sources.every(nonempty) || typeof value.collecting !== "boolean" ||
          !(value.nextRunAt === null || date(value.nextRunAt)) ||
          !(value.lastError === undefined || value.lastError === null ||
            object(value.lastError) && nonempty(value.lastError.code) && nonempty(value.lastError.message))) return false;
      const cycle = value.latestCycle;
      return cycle === null || object(cycle) && date(cycle.startedAt) && date(cycle.finishedAt) &&
        ["collectedCount", "rejectedCount", "skippedCount"].every((key) => count(cycle[key])) &&
        Array.isArray(cycle.events) && cycle.events.every((event) => object(event) &&
          ["id", "homeTeam", "awayTeam", "competition"].every((key) => nonempty(event[key])) && date(event.startsAt) &&
          Array.isArray(event.quotes) && event.quotes.length > 0 && event.quotes.every(match)) &&
        Array.isArray(cycle.alerts) && cycle.alerts.every(alert) && Array.isArray(cycle.errors) &&
        cycle.errors.every((error) => object(error) && nonempty(error.source) && nonempty(error.message));
    }

    // Refuse une réponse incomplète du service.
    function validatePayload(url, payload) {
      const valid = url.startsWith("/api/history") ? object(payload) && Array.isArray(payload.history) &&
        payload.history.every((entry) => match(entry) && nonempty(entry.eventId) && Number.isSafeInteger(entry.runId) && entry.runId > 0) : validState(payload);
      if (!valid) {
        const error = new Error("Le service a renvoyé des données incomplètes. Réessayez dans un instant.");
        error.code = "INVALID_RESPONSE";
        throw error;
      }
      return payload;
    }

    // Résume les problèmes de la dernière collecte.
    function cycleProblem() {
      if (state?.lastError) return state.lastError.message;
      const cycle = state?.latestCycle;
      if (!cycle?.errors.length) return "";
      return cycle.collectedCount === 0 ? "La dernière collecte a échoué : aucune cote n’a été récupérée. Consultez les détails et relancez une collecte." :
        "La dernière collecte est partielle : certaines sources ou données sont indisponibles. Consultez les détails ci-dessous.";
    }

    // Affiche les problèmes et l'ancienneté des données.
    function renderServiceNotice() {
      const disconnected = failures.has("state") || navigator.onLine === false;
      const problem = [...failures.values()][0] || cycleProblem();
      const message = navigator.onLine === false ? "Votre navigateur est hors ligne. Vérifiez la connexion puis réessayez." : problem;
      ui.serviceNotice.hidden = !message;
      ui.serviceNotice.classList.toggle("is-warning", !disconnected && !state?.lastError);
      ui.serviceMessage.textContent = message ? `${message} ${state?.latestCycle ?
        "Les cotes affichées correspondent à la dernière collecte enregistrée ; elles peuvent être périmées." : "Aucune donnée récente n’est confirmée."}` : "";
      ui.retry.textContent = failures.size || !state ? "Réessayer la connexion" : "Relancer une collecte";
      connection(!disconnected);
      if (disconnected) ui.lastUpdated.textContent = state?.latestCycle ?
        `Données non actualisées · dernière collecte : ${formatDate(state.latestCycle.finishedAt)}` : "Données indisponibles";
      else if (state?.lastError) ui.lastUpdated.textContent = "Dernière tentative en échec · données non actualisées";
      else if (state) ui.lastUpdated.textContent = state.latestCycle ?
        `Dernière collecte : ${formatDate(state.latestCycle.finishedAt)}` : "Aucune collecte pour le moment";
      ui.overview.dataset.stale = String(disconnected || Boolean(state?.lastError));
      ui.historyView.dataset.stale = String(disconnected || failures.has("history"));
      if (lastConfirmedAt) ui.connection.title = `Dernière réponse valide : ${formatDate(lastConfirmedAt)}`;
    }

    // Retient une panne pour la signaler.
    function failed(error, area = "state") {
      // Un formulaire refusé ne signifie pas une connexion coupée.
      if (!error.status || error.status >= 500) failures.set(area, error.message);
      renderServiceNotice();
    }

    // Crée un élément pour la page.
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }

    // Simplifie le texte pour faciliter la recherche.
    function normalizeSearch(value) {
      return String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
    }

    // Donne un nom lisible à chaque source.
    function sourceLabel(source) {
      if (/^(?:1xbet|onexbet)$/i.test(source)) return "1xBet";
      if (/^bet261$/i.test(source)) return "Bet261";
      if (/^pinnacle$/i.test(source)) return "Pinnacle";
      const match = /^exemple-([a-z0-9]+)$/i.exec(source);
      return match ? `Exemple ${match[1].toUpperCase()}` : source;
    }

    // Repère les sources ayant fourni des cotes.
    function sourcesWithData() {
      return new Set((state?.latestCycle?.events ?? []).flatMap((event) => event.quotes.map((quote) => quote.source)));
    }

    // Vérifie si une deuxième source manque.
    function needsSecondRealSource() {
      return state?.dataSource === "odds-api" && sourcesWithData().size < 2;
    }

    // Explique pourquoi les cotes restent incomparables.
    function realComparisonMessage() {
      if (state?.dataSource !== "odds-api") return "";
      if (needsSecondRealSource()) return state.sources.length < 2 ? secondRealSourceMessage :
        "Les écarts seront calculés lorsque deux sources réelles auront fourni des cotes.";
      if (!(state.latestCycle?.events ?? []).some((event) => event.quotes.length > 1)) {
        return "Pas encore de rencontre commune entre les sources pour cette collecte.";
      }
      return "";
    }

    // Indique d'où viennent les cotes affichées.
    function renderDataMode() {
      const real = state.dataSource === "odds-api";
      const sourceNames = state.sources.map(sourceLabel);
      const attribution = state.sources.map((source) => /^(?:1xbet|onexbet|pinnacle)$/i.test(source) ?
        `${sourceLabel(source)} via The Odds API` : /^bet261$/i.test(source) ? "Bet261 via ses pages publiques" : sourceLabel(source)).join(" · ");
      if (ui.dataModeLabel) {
        ui.dataModeLabel.textContent = real ? `Données réelles${sourceNames.length ? ` · ${sourceNames.join(" + ")}` : ""}` : "Mode démonstration";
        ui.dataModeLabel.closest(".demo-banner")?.classList.toggle("is-real", real);
      }
      if (ui.dataModeDescription) ui.dataModeDescription.textContent = real ?
        `Cotes 1X2 à venir${attribution ? ` · ${attribution}` : "."}` :
        "Explorez le comparateur avec vos données d’exemple. Les cotes affichées sont fictives.";
      if (ui.sourcesStatLabel) ui.sourcesStatLabel.textContent = real ? "Sources avec données" : "Sources comparées";
      if (ui.sourcesSubtitle) {
        const configured = state.sources.length;
        const available = sourcesWithData();
        const failed = state.sources.filter((source) => !available.has(source) &&
          (state.latestCycle?.errors ?? []).some((error) => error.source === source)).length;
        ui.sourcesSubtitle.textContent = real ?
          `${available.size > configured ? "" : "sur "}${configured} configurée${configured === 1 ? "" : "s"}${failed ? ` · ${failed} en échec` : ""}` :
          "fichiers de données locaux";
      }
      if (ui.sourcesKind) {
        ui.sourcesKind.textContent = real ? (state.sources.includes("bet261") ? "WEB / API" : "API") : "LOCAL";
        ui.sourcesKind.classList.toggle("is-api", real);
      }
      if (ui.sourcesNote) ui.sourcesNote.textContent = real ?
        (attribution ? `${attribution}.` : "Sources réelles configurées.") : "Des fichiers d’exemple, un format commun.";
      if (ui.footerDataMode) ui.footerDataMode.textContent = real ? "Données réelles" : "Données d’exemple";
      if (ui.comparisonNote) ui.comparisonNote.textContent = realComparisonMessage() ||
        "Les écarts comparent une même issue entre plusieurs sources.";
    }

    // Présente une date facile à lire.
    function formatDate(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "Date indisponible";
    }

    // Affiche un petit message temporaire.
    function showToast(message, error = false) {
      clearTimeout(toastTimer);
      ui.toast.textContent = message;
      ui.toast.classList.toggle("error", error);
      ui.toast.classList.add("show");
      toastTimer = setTimeout(() => ui.toast.classList.remove("show"), error ? 7000 : 4000);
    }

    // Indique si le service est joignable.
    function connection(connected) {
      ui.connection.textContent = connected ? "Connecté" : "Connexion interrompue";
      ui.connection.classList.toggle("is-offline", !connected);
      ui.connection.dataset.state = connected ? "connected" : "disconnected";
      const dot = ui.connection.parentElement?.querySelector(".status-dot");
      if (dot) dot.style.backgroundColor = connected ? "#28a373" : "#bb6c52";
    }

    // Demande des données et vérifie la réponse.
    async function request(url, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(url, { ...options, cache: "no-store", signal: controller.signal });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error("Le service a renvoyé une réponse illisible.");
        }
        if (!response.ok) {
          const error = new Error(typeof payload?.error === "string" ? payload.error :
            typeof payload?.message === "string" ? payload.message : `Le service a répondu avec l’erreur ${response.status}.`);
          error.status = response.status;
          error.code = typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`;
          throw error;
        }
        return validatePayload(url, payload);
      } catch (error) {
        if (error.name === "AbortError") {
          const timeoutError = new Error("Le service met trop de temps à répondre. Une collecte peut continuer sur le serveur ; vérifiez son état avant de la relancer.");
          timeoutError.code = "REQUEST_TIMEOUT";
          throw timeoutError;
        }
        if (error instanceof TypeError) throw new Error("Impossible de joindre le service. Vérifiez qu’il est démarré puis réessayez.");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    // Active les boutons selon l'action en cours.
    function updateControls() {
      const busy = collecting || saving || Boolean(state?.collecting);
      for (const button of [ui.collect, ui.emptyCollect]) {
        if (!button) continue;
        button.disabled = busy || !state;
        button.classList.toggle("is-loading", collecting || Boolean(state?.collecting));
        button.setAttribute("aria-busy", String(collecting || Boolean(state?.collecting)));
        const label = button.querySelector("[data-collect-label]");
        if (label) label.textContent = collecting || state?.collecting ? "Collecte en cours…" : "Lancer une collecte";
      }
      ui.save.disabled = busy || !settingsDirty || !state;
      ui.save.classList.toggle("is-loading", saving);
      ui.save.setAttribute("aria-busy", String(saving));
      for (const input of [ui.thresholdValue, ui.thresholdMode, ui.automatic]) input.disabled = saving || !state;
      ui.historyRefresh.disabled = loadingHistory;
      ui.historyRefresh.classList.toggle("is-loading", loadingHistory);
      ui.historyRefresh.setAttribute("aria-busy", String(loadingHistory));
      ui.overview.setAttribute("aria-busy", String(collecting || Boolean(state?.collecting)));
      ui.historyView.setAttribute("aria-busy", String(loadingHistory));
      ui.retry.disabled = collecting || saving || loadingState || loadingHistory || (!failures.size && Boolean(state?.collecting));
    }

    // Explique la limite choisie pour les alertes.
    function updateThresholdHelp() {
      const value = ui.thresholdValue.valueAsNumber;
      const display = Number.isFinite(value) && value >= 0 ? numberFormat.format(value) : "…";
      ui.thresholdHelp.textContent = ui.thresholdMode.value === "percentage" ?
        `Une alerte apparaît quand l’écart dépasse ${display} % de la cote la plus basse.` :
        `Une alerte apparaît quand l’écart dépasse ${display} point${value === 1 ? "" : "s"} de cote.`;
    }

    // Affiche les réglages actuellement appliqués.
    function renderSettings() {
      if (!settingsDirty) {
        ui.thresholdValue.value = String(state.settings.threshold.value);
        ui.thresholdMode.value = state.settings.threshold.mode;
        ui.automatic.checked = state.settings.automatic;
      }
      updateThresholdHelp();
      if (state.collecting || collecting) ui.nextCollection.textContent = "Collecte en cours…";
      else if (!state.settings.automatic) ui.nextCollection.textContent = "Collecte automatique désactivée";
      else if (state.nextRunAt) ui.nextCollection.textContent = `Prochaine collecte : ${formatDate(state.nextRunAt)}`;
      else ui.nextCollection.textContent = `Toutes les ${numberFormat.format(state.settings.intervalMinutes)} minutes`;
    }

    // Prépare la liste des championnats disponibles.
    function renderCompetitionFilter(events) {
      const selected = ui.competition.value;
      const competitions = [...new Set(events.map((event) => event.competition))].sort((a, b) => a.localeCompare(b, "fr"));
      const options = [new Option("Toutes les compétitions", ""), ...competitions.map((name) => new Option(name, name))];
      ui.competition.replaceChildren(...options);
      ui.competition.value = competitions.includes(selected) ? selected : "";
    }

    // Affiche un message quand la liste est vide.
    function emptyMessage(container, message) {
      let copy = container.querySelector(".empty-message, p");
      if (!copy) {
        copy = element("p", "empty-message");
        container.prepend(copy);
      }
      copy.textContent = message;
    }

    // Affiche le nom et la couleur d'une source.
    function sourceName(source) {
      const name = element("span", "source-name");
      const dot = element("span", "source-dot");
      dot.setAttribute("aria-hidden", "true");
      const index = Math.max(0, state?.sources.indexOf(source) ?? 0);
      dot.style.backgroundColor = sourceColors[index % sourceColors.length];
      name.append(dot, document.createTextNode(sourceLabel(source)));
      return name;
    }

    // Trouve le plus grand écart du match.
    function maxSpread(event) {
      if (event.quotes.length < 2) return null;
      return Math.max(...outcomes.map((outcome) => {
        const odds = event.quotes.map((quote) => quote.odds[outcome]);
        const minimum = Math.min(...odds);
        return (Math.max(...odds) - minimum) / minimum * 100;
      }));
    }

    // Prépare l'affichage des deux équipes.
    function matchNames(homeTeam, awayTeam) {
      const names = element("div", "match-names");
      names.append(element("span", "", homeTeam), element("span", "", awayTeam));
      return names;
    }

    // Affiche les matchs qui correspondent aux filtres.
    function renderMatches() {
      const events = state?.latestCycle?.events ?? [];
      const alertEvents = new Set((state?.latestCycle?.alerts ?? []).map((alert) => alert.eventId));
      const search = normalizeSearch(ui.search.value);
      const filtered = events.filter((event) =>
        (!search || normalizeSearch(`${event.homeTeam} ${event.awayTeam} ${event.competition}`).includes(search)) &&
        (!ui.competition.value || event.competition === ui.competition.value) &&
        (!ui.onlyAlerts.checked || alertEvents.has(event.id)));
      const fragment = document.createDocumentFragment();
      for (const event of filtered) {
        const extremes = Object.fromEntries(outcomes.map((outcome) => {
          const odds = event.quotes.map((quote) => quote.odds[outcome]);
          return [outcome, { min: Math.min(...odds), max: Math.max(...odds) }];
        }));
        event.quotes.forEach((quote, index) => {
          const tr = element("tr");
          tr.dataset.eventId = event.id;
          if (index === 0) {
            tr.id = `event-${event.id}`;
            tr.tabIndex = -1;
            const encounter = element("td");
            encounter.rowSpan = event.quotes.length;
            encounter.append(matchNames(event.homeTeam, event.awayTeam),
              element("div", "match-meta", `${event.competition} · ${formatDate(event.startsAt)}`));
            tr.append(encounter);
          }
          const source = element("td");
          source.append(sourceName(quote.source));
          tr.append(source);
          for (const outcome of outcomes) {
            const cell = element("td");
            const best = event.quotes.length > 1 && extremes[outcome].max > extremes[outcome].min &&
              quote.odds[outcome] === extremes[outcome].max;
            const odd = element("span", best ? "odd odd-best" : "odd", oddsFormat.format(quote.odds[outcome]));
            if (best) odd.title = "Meilleure cote disponible";
            cell.append(odd);
            tr.append(cell);
          }
          if (index === 0) {
            const spread = element("td");
            spread.rowSpan = event.quotes.length;
            const value = maxSpread(event);
            const positive = alertEvents.has(event.id);
            spread.append(element("span", positive ? "spread-badge is-positive" : "spread-badge spread-neutral",
              value === null ? "—" : `${oddsFormat.format(value)} %`));
            tr.append(spread);
          }
          fragment.append(tr);
        });
      }
      ui.matchesBody.replaceChildren(fragment);
      ui.matchCount.textContent = String(filtered.length);
      ui.matchCount.title = `${filtered.length} rencontre${filtered.length === 1 ? "" : "s"} affichée${filtered.length === 1 ? "" : "s"} sur ${events.length}`;
      ui.matchCount.setAttribute("aria-label", ui.matchCount.title);
      ui.matchesEmpty.hidden = filtered.length > 0;
      if (!filtered.length) {
        emptyMessage(ui.matchesEmpty, !state?.latestCycle ? "Lancez une collecte pour afficher les prochaines rencontres." :
          events.length ? "Aucune rencontre ne correspond à vos filtres." : "Aucune rencontre à venir n’a été collectée.");
      }
      if (ui.emptyCollect) ui.emptyCollect.hidden = events.length > 0;
    }

    // Affiche les écarts qui dépassent la limite.
    function renderAlerts() {
      const alerts = state?.latestCycle?.alerts ?? [];
      ui.alertsCount.textContent = String(alerts.length);
      const fragment = document.createDocumentFragment();
      for (const alert of alerts) {
        const card = element("article", "alert-card");
        const top = element("div", "alert-topline");
        const outcome = element("span", "outcome-badge", alert.outcome);
        outcome.setAttribute("aria-label", alert.outcome === "1" ? "Victoire à domicile" :
          alert.outcome === "X" ? "Match nul" : "Victoire à l’extérieur");
        top.append(outcome, element("span", "alert-value", `+${oddsFormat.format(alert.percentageDifference)} %`));
        const button = element("button", "text-button", "Voir la rencontre");
        button.type = "button";
        button.dataset.focusEvent = alert.eventId;
        card.append(top, element("div", "alert-teams", `${alert.homeTeam} — ${alert.awayTeam}`),
          element("p", "alert-comparison", `${sourceLabel(alert.minSource)} : ${oddsFormat.format(alert.minOdd)} → ${sourceLabel(alert.maxSource)} : ${oddsFormat.format(alert.maxOdd)}`),
          element("p", "match-meta", alert.competition), button);
        fragment.append(card);
      }
      if (!alerts.length) fragment.append(element("p", "empty-message", realComparisonMessage() || (
        state?.latestCycle ? "Aucun écart ne dépasse le seuil actuel." : "Les écarts apparaîtront après la première collecte.")));
      ui.alertsList.replaceChildren(fragment);
    }

    // Affiche les sources et leurs résultats.
    function renderSources() {
      const quotes = (state.latestCycle?.events ?? []).flatMap((event) => event.quotes);
      const fragment = document.createDocumentFragment();
      for (const source of state.sources) {
        const count = quotes.filter((quote) => quote.source === source).length;
        const chip = element("span", "source-chip");
        const failed = count === 0 && (state.latestCycle?.errors ?? []).some((error) => error.source === source);
        chip.textContent = `${sourceLabel(source)} · ${failed ? "collecte en échec" : !state.latestCycle ?
          "en attente de collecte" : `${count} observation${count === 1 ? "" : "s"}`}`;
        chip.classList.toggle("source-chip-error", failed);
        fragment.append(chip);
      }
      if (!state.sources.length) fragment.append(element("p", "empty-message", "Aucune source disponible."));
      ui.sourcesList.replaceChildren(fragment);
    }

    // Affiche les problèmes rencontrés pendant la collecte.
    function renderDiagnostics() {
      const cycle = state.latestCycle;
      const rejected = cycle?.rejectedCount ?? 0;
      const skipped = cycle?.skippedCount ?? 0;
      const errors = cycle?.errors ?? [];
      ui.diagnostics.hidden = rejected + skipped + errors.length === 0;
      ui.diagnosticsSummary.textContent = `${rejected} ligne${rejected === 1 ? "" : "s"} invalide${rejected === 1 ? "" : "s"} · ${skipped} passée${skipped === 1 ? "" : "s"} ou doublon${skipped === 1 ? "" : "s"} · ${errors.length} erreur${errors.length === 1 ? "" : "s"}`;
      const items = errors.map((error) => element("li", "", `${sourceLabel(error.source)} : ${error.message}`));
      if (skipped) items.unshift(element("li", "", `${skipped} rencontre${skipped === 1 ? "" : "s"} passée${skipped === 1 ? "" : "s"} ou observation${skipped === 1 ? "" : "s"} en double ignorée${skipped === 1 ? "" : "s"}.`));
      ui.diagnosticsList.replaceChildren(...items);
    }

    // Actualise la page avec les nouvelles données.
    function applyState(next) {
      state = next;
      renderDataMode();
      const events = state.latestCycle?.events ?? [];
      ui.matchesStat.textContent = String(events.length);
      ui.sourcesStat.textContent = state.dataSource === "odds-api" ?
        (state.latestCycle ? String(sourcesWithData().size) : "—") : String(state.sources.length);
      ui.alertsStat.textContent = String(state.latestCycle?.alerts.length ?? 0);
      ui.matchedStat.textContent = String(events.filter((event) => event.quotes.length > 1).length);
      ui.lastUpdated.textContent = state.latestCycle ? `Dernière collecte : ${formatDate(state.latestCycle.finishedAt)}` : "Aucune collecte pour le moment";
      renderSettings();
      renderCompetitionFilter(events);
      renderMatches();
      renderAlerts();
      renderSources();
      renderDiagnostics();
      failures.delete("state");
      lastConfirmedAt = new Date().toISOString();
      renderServiceNotice();
      updateControls();
    }

    // Récupère les dernières données du service.
    async function refreshState({ quiet = false } = {}) {
      if (loadingState || collecting || saving) return;
      loadingState = true;
      updateControls();
      const revision = ++stateRevision;
      const previousCycle = state?.latestCycle?.finishedAt;
      try {
        const next = await request("/api/state");
        if (revision !== stateRevision) return;
        applyState(next);
        if (next.latestCycle?.finishedAt !== previousCycle && (historyLoaded || view === "history")) void refreshHistory({ quiet: true });
      } catch (error) {
        failed(error);
        if (!quiet) showToast(error.message || "Impossible de charger le tableau de bord.", true);
      } finally {
        loadingState = false;
        updateControls();
      }
    }

    // Affiche les anciens relevés de cotes.
    function renderHistory() {
      const search = normalizeSearch(ui.historySearch.value);
      const rows = history.filter((entry) => !search ||
        normalizeSearch(`${entry.homeTeam} ${entry.awayTeam} ${entry.competition} ${sourceLabel(entry.source)}`).includes(search));
      const fragment = document.createDocumentFragment();
      for (const entry of rows) {
        const tr = element("tr");
        tr.append(element("td", "", formatDate(entry.collectedAt)));
        const encounter = element("td");
        encounter.append(matchNames(entry.homeTeam, entry.awayTeam),
          element("div", "match-meta", `${entry.competition} · ${formatDate(entry.startsAt)}`));
        const source = element("td");
        source.append(sourceName(entry.source));
        tr.append(encounter, source);
        for (const outcome of outcomes) {
          const cell = element("td");
          cell.append(element("span", "odd", oddsFormat.format(entry.odds[outcome])));
          tr.append(cell);
        }
        fragment.append(tr);
      }
      ui.historyBody.replaceChildren(fragment);
      ui.historyEmpty.hidden = rows.length > 0 || loadingHistory;
      if (!rows.length) emptyMessage(ui.historyEmpty, !historyLoaded ? "L’historique n’a pas encore pu être chargé." :
        history.length ? "Aucune observation ne correspond à votre recherche." : "L’historique apparaîtra après la première collecte.");
    }

    // Récupère les anciens relevés enregistrés.
    async function refreshHistory({ quiet = false } = {}) {
      const revision = ++historyRevision;
      const selected = Number(ui.historyLimit.value);
      const limit = [50, 100, 250].includes(selected) ? selected : 50;
      loadingHistory = true;
      updateControls();
      renderHistory();
      try {
        const payload = await request(`/api/history?limit=${limit}`);
        if (revision !== historyRevision) return;
        history = payload.history;
        historyLoaded = true;
        failures.delete("history");
        renderServiceNotice();
      } catch (error) {
        if (revision === historyRevision) failed(error, "history");
        if (revision === historyRevision && !quiet) showToast(error.message || "Impossible de charger l’historique.", true);
      } finally {
        if (revision === historyRevision) {
          loadingHistory = false;
          renderHistory();
          updateControls();
        }
      }
    }

    // Lance une collecte depuis le bouton.
    async function collect() {
      if (!state || collecting || saving || state.collecting) return;
      collecting = true;
      const revision = ++stateRevision;
      updateControls();
      renderSettings();
      try {
        const next = await request("/api/collect", { method: "POST" });
        if (revision === stateRevision) applyState(next);
        const cycle = next.latestCycle;
        if (cycle?.errors.length) showToast(cycle.collectedCount === 0 ?
          "La collecte a échoué : aucune cote récupérée. Consultez les détails." :
          `Collecte partielle : ${cycle.collectedCount} observations. Certaines données sont indisponibles.`, true);
        else showToast(cycle ? `${cycle.collectedCount} observations collectées · ${cycle.alerts.length} alerte${cycle.alerts.length === 1 ? "" : "s"}.` : "Collecte terminée.");
        await refreshHistory({ quiet: true });
      } catch (error) {
        failed(error);
        showToast(error.message || "La collecte a échoué.", true);
      } finally {
        collecting = false;
        updateControls();
        if (state) renderSettings();
      }
    }

    // Enregistre les réglages choisis dans la page.
    async function saveSettings(event) {
      event.preventDefault();
      if (!state || saving || collecting || state.collecting) return;
      const mode = ui.thresholdMode.value;
      const value = ui.thresholdValue.valueAsNumber;
      if (!["percentage", "absolute"].includes(mode) || !Number.isFinite(value) || value < 0) {
        showToast("Choisissez un seuil valide, supérieur ou égal à zéro.", true);
        ui.thresholdValue.focus();
        return;
      }
      saving = true;
      const revision = ++stateRevision;
      updateControls();
      try {
        const next = await request("/api/settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threshold: { mode, value }, automatic: ui.automatic.checked }),
        });
        settingsDirty = false;
        if (revision === stateRevision) applyState(next);
        showToast("Paramètres enregistrés.");
      } catch (error) {
        failed(error);
        showToast(error.message || "Impossible d’enregistrer les paramètres.", true);
      } finally {
        saving = false;
        updateControls();
      }
    }

    // Passe entre les matchs et l'historique.
    function showView(nextView) {
      view = nextView === "history" ? "history" : "overview";
      ui.overview.hidden = view !== "overview";
      ui.historyView.hidden = view !== "history";
      ui.title.textContent = view === "history" ? "Historique" : "Vue d’ensemble";
      ui.description.textContent = view === "history" ?
        "Retrouvez les cotes enregistrées à chaque collecte." : "Comparez les prochaines rencontres et repérez les écarts de cotes.";
      for (const button of navigation) {
        const active = button.dataset.view === view;
        button.classList.toggle("is-active", active);
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      if (view === "history") void refreshHistory();
    }

    for (const button of navigation) button.addEventListener("click", (event) => {
      event.preventDefault();
      showView(button.dataset.view);
    });
    ui.collect.addEventListener("click", collect);
    ui.emptyCollect?.addEventListener("click", collect);
    ui.settingsForm.addEventListener("submit", saveSettings);
    for (const input of [ui.thresholdValue, ui.thresholdMode, ui.automatic]) input.addEventListener("input", () => {
      settingsDirty = true;
      updateThresholdHelp();
      updateControls();
    });
    ui.search.addEventListener("input", renderMatches);
    ui.competition.addEventListener("change", renderMatches);
    ui.onlyAlerts.addEventListener("change", renderMatches);
    ui.historySearch.addEventListener("input", renderHistory);
    ui.historyLimit.addEventListener("change", () => void refreshHistory());
    ui.historyRefresh.addEventListener("click", () => void refreshHistory());
    ui.retry.addEventListener("click", async () => {
      if (failures.size || !state) {
        await refreshState();
        if (failures.has("history")) await refreshHistory();
      } else await collect();
    });
    ui.alertsList.addEventListener("click", (click) => {
      const button = click.target.closest("[data-focus-event]");
      if (!button) return;
      const event = state?.latestCycle?.events.find((item) => item.id === button.dataset.focusEvent);
      if (!event) return;
      ui.search.value = `${event.homeTeam} ${event.awayTeam}`;
      ui.competition.value = "";
      ui.onlyAlerts.checked = false;
      showView("overview");
      renderMatches();
      const row = byId(`event-${event.id}`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void refreshState({ quiet: true });
        if (view === "history") void refreshHistory({ quiet: true });
      }
    });
    window.addEventListener("offline", () => {
      failures.set("state", "Votre navigateur est hors ligne.");
      renderServiceNotice();
    });
    window.addEventListener("online", () => {
      void refreshState({ quiet: true });
      if (view === "history" || failures.has("history")) void refreshHistory({ quiet: true });
    });

    ui.connection.textContent = "Connexion…";
    updateControls();
    renderMatches();
    renderHistory();
    void refreshState();
    setInterval(() => {
      if (!document.hidden) void refreshState({ quiet: true });
    }, 8000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

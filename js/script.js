(function () {
  "use strict";

  /* ==================== ESTADO GLOBAL ==================== */
  var state = { tables: [] };

  /* ==================== UTILITARIOS ==================== */
  function $(id) {
    return document.getElementById(id);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function showEl(id) {
    $(id).classList.remove("hidden");
  }
  function hideEl(id) {
    $(id).classList.add("hidden");
  }
  function setError(id, msg) {
    var el = $(id);
    if (!msg) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.classList.remove("hidden");
    el.textContent = msg;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function toast(msg, type) {
    var el = document.createElement("div");
    el.className = "toast " + (type || "success");
    el.textContent = msg;
    $("toastRoot").appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 5000);
  }

  function api(method, url, body) {
    var opts = {
      method: method,
      headers: {},
      credentials: "same-origin",
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || "Erro HTTP " + res.status);
            err.data = data;
            err.status = res.status;
            throw err;
          }
          return data;
        });
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments,
        self = this;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(self, args);
      }, ms);
    };
  }

  /* ================================================================
   * FUNCOES UTILITARIAS COMPARTILHADAS (usadas pela tela de selecao)
   * ================================================================ */
  function renderPreviewTable(tableId, headers, rows) {
    var table = $(tableId);
    if (!table) return;
    var thead =
      "<thead><tr>" +
      headers
        .map(function (h) {
          return "<th>" + escapeHtml(h) + "</th>";
        })
        .join("") +
      "</tr></thead>";
    var tbody =
      "<tbody>" +
      rows
        .map(function (row) {
          return (
            "<tr>" +
            row
              .map(function (cell) {
                return "<td>" + escapeHtml(cell == null ? "" : cell) + "</td>";
              })
              .join("") +
            "</tr>"
          );
        })
        .join("") +
      "</tbody>";
    table.innerHTML = thead + tbody;
  }

  function renderTableList(containerId, tables, onSelect) {
    var container = $(containerId);
    if (!container) return;
    container.innerHTML = tables
      .map(function (t) {
        var name = t.table_name || t;
        return (
          '<div class="tableListItem" data-name="' +
          escapeHtml(name) +
          '">' +
          escapeHtml(name) +
          '<span class="small">' +
          (t.row_count != null ? t.row_count + " regs" : "") +
          "</span></div>"
        );
      })
      .join("");
    qsa(".tableListItem", container).forEach(function (item) {
      item.addEventListener("click", function () {
        onSelect(this.getAttribute("data-name"));
      });
    });
  }

  function selectFromList(containerId, name) {
    var container = $(containerId);
    if (!container) return;
    qsa(".tableListItem", container).forEach(function (item) {
      item.classList.toggle(
        "selected",
        item.getAttribute("data-name") === name,
      );
    });
  }

  /* ==================== MAPA DE EMPREENDIMENTOS ==================== */
  // Cores centralizadas por DESTINACAO (substitui o antigo esquema por
  // status): cada valor distinto da coluna "destinacao" recebe uma cor viva
  // e elegante, gerada automaticamente de forma DETERMINISTICA (mesma
  // destinacao sempre produz a mesma cor, em qualquer carregamento da
  // pagina, sem depender de ordem de chegada dos dados). Nao ha mais mapa
  // fixo de cores: tudo -- poligonos, popup, legenda e estatisticas -- usa
  // exclusivamente a funcao getDestinationColor() abaixo.
  var DESTINATION_COLOR_CACHE = {};
  var DESTINATION_HUE_STEP = 137.508; // angulo aureo: espalha os tons de forma visualmente distinta

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0,
      g = 0,
      b = 0;
    if (h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }
    var toHex = function (v) {
      var hx = Math.round((v + m) * 255).toString(16);
      return hx.length === 1 ? "0" + hx : hx;
    };
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }

  /* Cor consistente e determinada a partir do texto da destinacao: mesmo
   * texto -> mesmo tom (hue) sempre, com saturacao/luminosidade fixas numa
   * faixa "viva porem elegante" (nao neon, nao pastel). Qualquer destinacao
   * nova -- ainda nao vista -- recebe automaticamente uma cor propria na
   * primeira vez que passa por aqui, sem precisar de cadastro manual. */
  function getDestinationColor(destinacao) {
    var key = String(destinacao || "").trim();
    if (!key) return "#94a3b8";
    var normalized = key.toLowerCase();
    if (!DESTINATION_COLOR_CACHE[normalized]) {
      var h = hashString(normalized);
      var hue = (h * DESTINATION_HUE_STEP) % 360;
      var saturation = 62 + (h % 15); // 62% - 76%
      var lightness = 42 + (h % 11); // 42% - 52%
      DESTINATION_COLOR_CACHE[normalized] = hslToHex(
        hue,
        saturation,
        lightness,
      );
    }
    return DESTINATION_COLOR_CACHE[normalized];
  }

  // Definicoes de camada (basemap) para o Leaflet. "url" usa o padrao {s}
  // (subdominio) do proprio Leaflet; quando o provedor nao tem subdominios
  // (ex: Esri), "subdomains" fica vazio. Apenas os TILES (imagens de mapa)
  // vem de servicos externos -- a BIBLIOTECA do mapa em si (Leaflet) e 100%
  // local, ver /vendor/leaflet no <head>.
  var MAP_LAYER_DEFS = [
    {
      id: "osm",
      label: "Mapa",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      subdomains: ["a", "b", "c"],
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19,
    },
    {
      id: "positron",
      label: "Claro",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=cb1_2tfb_1_94f8ef545a85ef4c2451507a",
      subdomains: ["a", "b", "c"],
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 20,
    },
    {
      id: "dark",
      label: "Escuro",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=cb1_2tfb_1_94f8ef545a85ef4c2451507a",
      subdomains: ["a", "b", "c"],
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 20,
    },
    {
      id: "satellite",
      label: "Satelite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      subdomains: [],
      attribution: "Esri",
      maxZoom: 19,
    },
    {
      id: "topo",
      label: "Relevo",
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      subdomains: ["a", "b", "c"],
      attribution: "&copy; OpenTopoMap",
      maxZoom: 17,
    },
  ];

  var MapModule = (function () {
    var map = null,
      tileLayer = null,
      polygonLayer = null,
      markerLayer = null,
      currentLayerId = "positron";
    var abortController = null,
      lastItems = [];
    var selectedPolygonLayer = null; // garante que apenas 1 poligono fique com o destaque de "selecionado"
    var selTable = null,
      selColumn = null;

    /* Extrai uma mensagem de erro sempre legivel. Usada em todo o modulo para
     * evitar o problema de exibir literalmente "undefined" quando o valor
     * rejeitado/lancado nao e um Error "de verdade" (ex: string solta,
     * objeto sem campo message, ou throw sem valor nenhum). */
    function getErrorMessage(err) {
      if (err === undefined || err === null)
        return "Erro desconhecido (nenhum detalhe informado).";
      if (typeof err === "string") return err;
      if (err instanceof Error && err.message) return err.message;
      if (typeof err === "object" && err.message) return String(err.message);
      try {
        return JSON.stringify(err);
      } catch (e) {
        return String(err);
      }
    }

    /* ================================================================
     * ENTRADA
     * Sempre mostra a tela de selecao primeiro: o mapa em si so aparece
     * depois que o usuario escolhe explicitamente a tabela e a coluna de
     * localizacao (geometry/geography). Nada e assumido automaticamente.
     * ================================================================ */
    function enter() {
      console.log("[map] Painel do mapa aberto (tela de selecao de fonte).");
      showEl("mapSelectView");
      hideEl("mapView");
      selTable = null;
      selColumn = null;
      setError("mapSelectError", null);
      hideEl("mapSelectPreviewWrap");
      hideEl("mapSelectStepColumn");
      showEl("mapSelectStepTable");
      $("mapOpenBtn").disabled = true;
      loadSelectTables();
    }

    function backToSelect() {
      hideEl("mapView");
      enter();
    }

    /* ---------------- Passo 1: escolher a tabela ---------------- */
    function loadSelectTables() {
      api("GET", "/api/db/tables")
        .then(function (data) {
          state.tables = data.tables;
          renderSelectTableList(state.tables);
        })
        .catch(function (err) {
          console.error("[map] Falha ao listar tabelas do banco:", err);
          setError("mapSelectError", getErrorMessage(err));
        });
    }

    function renderSelectTableList(tables) {
      renderTableList("mapSelectTableList", tables, function (name) {
        selectFromList("mapSelectTableList", name);
        selTable = name;
        selColumn = null;
        $("mapOpenBtn").disabled = true;
        api("GET", "/api/db/tables/" + name + "/preview")
          .then(function (data) {
            var headers = data.columns.map(function (c) {
              return c.column_name;
            });
            var rows = data.rows.slice(0, 5).map(function (r) {
              return headers.map(function (h) {
                return r[h];
              });
            });
            showEl("mapSelectPreviewWrap");
            renderPreviewTable("mapSelectPreviewTable", headers, rows);
          })
          .catch(function () {
            /* preview e apenas informativo */
          });
        goToColumnStep(name);
      });
    }

    $("mapSelectTableSearch").addEventListener("input", function () {
      var q = this.value.toLowerCase();
      renderSelectTableList(
        state.tables.filter(function (t) {
          return t.table_name.toLowerCase().indexOf(q) >= 0;
        }),
      );
    });
    $("mapSelectBackBtn").addEventListener("click", function () {
      hideEl("mapSelectStepColumn");
      showEl("mapSelectStepTable");
    });

    /* ---------------- Passo 2: escolher a coluna de localizacao ---------------- */
    function goToColumnStep(tableName) {
      setError("mapSelectError", null);
      $("mapSelectSelectedTable").textContent = tableName;
      api("GET", "/api/mapa/fontes")
        .then(function (data) {
          var cols = (data.fontes || []).filter(function (f) {
            return f.schema === "public" && f.table === tableName;
          });
          hideEl("mapSelectStepTable");
          showEl("mapSelectStepColumn");
          if (!cols.length) {
            showEl("mapSelectNoSpatial");
            $("mapSelectColumnList").innerHTML = "";
            return;
          }
          hideEl("mapSelectNoSpatial");
          renderSelectColumnList(cols);
        })
        .catch(function (err) {
          console.error(
            "[map] Falha ao listar colunas espaciais da tabela " +
              tableName +
              ":",
            err,
          );
          setError("mapSelectError", getErrorMessage(err));
        });
    }

    function renderSelectColumnList(cols) {
      var container = $("mapSelectColumnList");
      container.innerHTML = cols
        .map(function (c) {
          return (
            '<div class="tableListItem" data-col="' +
            escapeHtml(c.column) +
            '">' +
            escapeHtml(c.column) +
            '<span class="small">' +
            escapeHtml(c.kind) +
            (c.srid ? " &middot; SRID " + c.srid : "") +
            "</span></div>"
          );
        })
        .join("");
      qsa(".tableListItem", container).forEach(function (item) {
        item.addEventListener("click", function () {
          selectFromList("mapSelectColumnList", item.getAttribute("data-col"));
          selColumn = item.getAttribute("data-col");
          $("mapOpenBtn").disabled = false;
        });
      });
    }

    /* ---------------- Confirmar e abrir o mapa ---------------- */
    $("mapOpenBtn").addEventListener("click", function () {
      if (!selTable || !selColumn) return;
      var btn = this;
      btn.disabled = true;
      setError("mapSelectError", null);
      console.log(
        "[map] Configurando fonte de dados do mapa:",
        selTable,
        selColumn,
      );
      api("POST", "/api/mapa/config", {
        schema: "public",
        table: selTable,
        column: selColumn,
      })
        .then(function () {
          hideEl("mapSelectView");
          showEl("mapView");
          openMap();
        })
        .catch(function (err) {
          console.error(
            "[map] Falha ao salvar a configuracao da fonte de dados:",
            err,
          );
          setError("mapSelectError", getErrorMessage(err));
          btn.disabled = false;
        });
    });

    /* ================================================================
     * MAPA -- so e construido depois que a tabela + coluna sao escolhidas.
     *
     * IMPORTANTE (causa raiz do bug "Map container is already initialized"):
     * o Leaflet marca o elemento DOM usado em L.map(...) com uma propriedade
     * interna (container._leaflet_id) na primeira inicializacao. Chamar
     * L.map() de novo sobre o MESMO elemento -- por exemplo, reconstruindo o
     * mapa toda vez que o botao "Tentar novamente" e clicado -- faz o
     * Leaflet lancar exatamente esse erro. A solucao correta NAO e recriar o
     * mapa a cada tentativa: a instancia de L.map() e criada UMA UNICA VEZ
     * (guardada na variavel "map", no escopo do modulo) e reaproveitada daí
     * em diante; qualquer nova chamada de openMap() apenas reutiliza essa
     * instancia e recarrega dados/marcadores.
     * ================================================================ */
    function buildTileLayer(layerId) {
      var def =
        MAP_LAYER_DEFS.filter(function (l) {
          return l.id === layerId;
        })[0] || MAP_LAYER_DEFS[0];
      console.log("[map] Criando camada de tiles (basemap):", def.id);
      var opts = {
        attribution: def.attribution,
        maxZoom: def.maxZoom || 19,
      };
      if (def.subdomains && def.subdomains.length)
        opts.subdomains = def.subdomains;
      return L.tileLayer(def.url, opts);
    }

    function openMap() {
      console.log("[map] openMap() chamado. Instancia ja existe?", !!map);

      /* Mapa ja inicializado: NUNCA chamar L.map() de novo. Apenas garante
       * que o tamanho esteja correto (o container pode ter ficado oculto
       * entre uma visita e outra do painel) e recarrega filtros/dados. */
      if (map) {
        console.log(
          "[map] Reutilizando a instancia existente do mapa (sem recriar).",
        );
        setTimeout(function () {
          try {
            map.invalidateSize();
          } catch (e) {
            console.warn("[map] invalidateSize() falhou (nao critico):", e);
          }
        }, 50);
        loadFilterOptions();
        loadData();
        return;
      }

      if (typeof L === "undefined") {
        var libMsg =
          "Nao foi possivel carregar a biblioteca do mapa (Leaflet). Verifique se as dependencias locais foram instaladas (npm install) e recarregue a pagina.";
        console.error("[map] " + libMsg);
        setState("error", libMsg);
        return;
      }

      var container = $("mapCanvas");
      if (!container) {
        var domMsg = "Elemento #mapCanvas nao encontrado no DOM.";
        console.error("[map] " + domMsg);
        setState("error", "Falha ao inicializar o mapa: " + domMsg);
        return;
      }

      /* Rede de seguranca: se uma tentativa anterior deixou o container
       * marcado como "ja inicializado" pelo Leaflet (por exemplo, uma
       * excecao no meio da montagem, antes de limparmos o estado), removemos
       * essa marca residual antes de tentar de novo -- assim uma nova
       * abertura do painel (que chama openMap com map === null) sempre
       * consegue criar o L.map() com sucesso. */
      if (container._leaflet_id) {
        console.warn(
          "[map] Container #mapCanvas tinha um _leaflet_id residual de uma tentativa anterior; limpando antes de recriar.",
        );
        delete container._leaflet_id;
      }

      try {
        console.log(
          "[map] Inicializando o mapa Leaflet (primeira vez nesta sessao)...",
        );
        renderLayerSwitcher();
        map = L.map(container, {
          center: [-8.05, -38.5],
          zoom: 6.5,
          zoomControl: false,
        });
        L.control.zoom({ position: "topleft" }).addTo(map);
        tileLayer = buildTileLayer(currentLayerId);
        tileLayer.addTo(map);
        /* Camada de poligonos: e a UNICA representacao visual dos registros
         * no mapa (os antigos circulos/marcadores foram removidos por
         * completo -- ver buildPolygonStyle/wirePolygonInteractions).
         * Adicionada diretamente ao mapa (sem agrupamento por zoom), assim
         * os poligonos permanecem visiveis em qualquer nivel de zoom, sem
         * depender de eventos 'zoom'/'zoomend'. Suporta Polygon e
         * MultiPolygon nativamente (L.geoJSON). "smoothFactor" mais alto
         * deixa os contornos com aparencia mais suave/arredondada. */
        polygonLayer = L.geoJSON(null, {
          smoothFactor: 1.5,
          style: buildPolygonStyle,
          onEachFeature: wirePolygonInteractions,
        });
        map.addLayer(polygonLayer);
        markerLayer = L.layerGroup();
        map.addLayer(markerLayer);
        map.on("mousemove", function (e) {
          var el = $("mapCoordReadout");
          if (el)
            el.textContent =
              e.latlng.lat.toFixed(4) + ", " + e.latlng.lng.toFixed(4);
        });
        wireControls();
        wireFilters();
        console.log("[map] Mapa Leaflet inicializado com sucesso.");
        /* CAUSA RAIZ do bug "marcadores somem, so aparecem durante o zoom":
         * o container #mapCanvas acabou de sair de "display:none" (classe
         * "hidden" removida logo antes de chamar openMap()) e o Leaflet mede
         * o tamanho do container no momento do L.map(...) -- antes do
         * navegador terminar o reflow -- guardando esse tamanho (errado) em
         * cache interno (this._size). Esse cache so e recalculado com um
         * invalidateSize() explicito; sem ele, todo o "pixel origin" usado
         * para posicionar tiles/marcadores fica desalinhado permanentemente,
         * o que faz os marcadores parecerem "piscar" para o lugar certo
         * durante a animacao de zoom e sumirem de novo assim que ela termina
         * (zoomend recalcula com o mesmo cache errado). O ramo de
         * reaproveitamento do mapa (bloco "if (map) {...}" acima) ja fazia
         * exatamente esse invalidateSize() -- faltava apenas aplicar o mesmo
         * tratamento aqui, na primeira inicializacao. */
        setTimeout(function () {
          try {
            map.invalidateSize();
          } catch (e) {
            console.warn(
              "[map] invalidateSize() falhou apos inicializacao (nao critico):",
              e,
            );
          }
        }, 50);
        loadFilterOptions();
        loadData();
      } catch (err) {
        var message = getErrorMessage(err);
        console.error("[map] Falha ao inicializar o mapa:", err);
        // Desfaz qualquer estado parcial para permitir uma nova tentativa
        // real (via reabertura do painel), sem deixar o container "sujo".
        if (map) {
          try {
            map.remove();
          } catch (e2) {
            console.warn(
              "[map] Erro ao limpar mapa parcialmente inicializado:",
              e2,
            );
          }
        }
        map = null;
        tileLayer = null;
        polygonLayer = null;
        selectedPolygonLayer = null;
        if (container._leaflet_id) delete container._leaflet_id;
        setState("error", "Falha ao inicializar o mapa: " + message);
      }
    }

    function switchLayer(layerId) {
      if (!map) {
        console.warn(
          "[map] switchLayer chamado sem mapa inicializado; ignorado.",
        );
        return;
      }
      console.log("[map] Trocando camada de tiles para:", layerId);
      currentLayerId = layerId;
      renderLayerSwitcher();
      if (tileLayer) map.removeLayer(tileLayer);
      tileLayer = buildTileLayer(layerId);
      tileLayer.addTo(map);
    }

    function renderLayerSwitcher() {
      var el = $("mapLayerSwitcher");
      el.innerHTML = MAP_LAYER_DEFS.map(function (l) {
        return (
          '<button type="button" class="mapLayerBtn' +
          (l.id === currentLayerId ? " active" : "") +
          '" data-layer="' +
          l.id +
          '">' +
          escapeHtml(l.label) +
          "</button>"
        );
      }).join("");
      qsa(".mapLayerBtn", el).forEach(function (btn) {
        btn.addEventListener("click", function () {
          switchLayer(this.getAttribute("data-layer"));
        });
      });
    }

    /* ---------------- Poligonos: estilo, hover e selecao ----------------
     * Os antigos circulos/marcadores (L.circleMarker) foram removidos por
     * completo -- o poligono e a UNICA representacao visual de cada
     * registro no mapa. Tudo abaixo e organizado em funcoes pequenas e
     * reutilizaveis (estilo base / hover / selecao / eventos), sem logica
     * duplicada entre elas. */

    // Estilo "base" (repouso) de um poligono: visual moderno (tipo Google
    // Maps/ArcGIS) -- borda mais grossa, cantos arredondados (suavizados),
    // preenchimento translucido e cor viva definida pela DESTINACAO.
    function buildPolygonStyle(feature) {
      var color = getDestinationColor(
        feature.properties && feature.properties.destinacao,
      );
      return {
        color: color,
        weight: 2.5,
        opacity: 0.9,
        fillColor: color,
        fillOpacity: 0.3,
        lineJoin: "round",
        lineCap: "round",
      };
    }

    // Estilo aplicado enquanto o mouse esta sobre o poligono: borda um
    // pouco mais grossa e mais opaca, preenchimento levemente mais forte.
    function buildHoverStyle(baseStyle) {
      return {
        weight: baseStyle.weight + 1.5,
        opacity: 1,
        fillOpacity: Math.min(0.5, baseStyle.fillOpacity + 0.15),
      };
    }

    // Estilo do poligono SELECIONADO: borda branca de destaque (com um
    // contorno escuro por baixo, via "pane"/z-index do proprio Leaflet ao
    // trazer a camada para frente) para continuar legivel em qualquer
    // basemap, claro ou escuro.
    function buildSelectedStyle(baseStyle) {
      return {
        color: "#ffffff",
        weight: 4,
        opacity: 1,
        fillColor: baseStyle.fillColor,
        fillOpacity: Math.min(0.55, baseStyle.fillOpacity + 0.2),
      };
    }

    // Restaura o estilo correto de uma camada: o estilo de selecao (se for
    // a camada atualmente selecionada) ou o estilo base (repouso).
    function restorePolygonStyle(layer) {
      if (layer === selectedPolygonLayer) {
        layer.setStyle(buildSelectedStyle(layer._baseStyle));
      } else {
        layer.setStyle(layer._baseStyle);
      }
    }

    // Seleciona um unico poligono por vez: desfaz o destaque do poligono
    // selecionado anteriormente (se houver) e aplica o destaque no novo.
    function selectPolygon(layer) {
      if (selectedPolygonLayer && selectedPolygonLayer !== layer) {
        var previous = selectedPolygonLayer;
        previous.setStyle(previous._baseStyle);
      }
      selectedPolygonLayer = layer;
      layer.setStyle(buildSelectedStyle(layer._baseStyle));
      if (layer.bringToFront) layer.bringToFront();
    }

    // Liga os eventos de hover/clique de um poligono. Chamada uma vez por
    // feature (via onEachFeature do L.geoJSON).
    function wirePolygonInteractions(feature, layer) {
      layer._baseStyle = buildPolygonStyle(feature);
      layer.on({
        mouseover: function () {
          layer.setStyle(buildHoverStyle(layer._baseStyle));
          if (layer.bringToFront) layer.bringToFront();
        },
        mouseout: function () {
          restorePolygonStyle(layer);
        },
        click: function () {
          selectPolygon(layer);
          showPopup(feature.properties, layer);
        },
      });
    }

    /* Poligonos permanentes: reconstruidos a partir do cache de dados
     * (lastItems), entao ficam automaticamente sincronizados com os
     * filtros aplicados (Name/Destinacao/Layer) e com qualquer atualizacao
     * dos dados -- sem depender de zoom/pan. Usa a geometria
     * (Polygon/MultiPolygon) ja vinda pronta da API, sem gerar nem
     * simplificar geometria no cliente. */
    function renderPolygonsFromCache() {
      polygonLayer.clearLayers();
      markerLayer.clearLayers();

      selectedPolygonLayer = null;

      lastItems.forEach(function (item) {
        // POLÍGONO
        if (
          item.geometry &&
          (item.geometry.type === "Polygon" ||
            item.geometry.type === "MultiPolygon")
        ) {
          polygonLayer.addData({
            type: "Feature",
            geometry: item.geometry,
            properties: item,
          });

          return;
        }

        // LAT/LONG
        if (item.latitude != null && item.longitude != null) {
          var marker = L.circleMarker(
            [Number(item.latitude), Number(item.longitude)],
            {
              radius: 8,
              color: getDestinationColor(item.destinacao),
              fillColor: getDestinationColor(item.destinacao),
              fillOpacity: 0.8,
              weight: 2,
            },
          );

          marker.on("click", function () {
            showPopup(item, marker);
          });

          markerLayer.addLayer(marker);
        }
      });
    }

    function rowHtml(label, value) {
      if (value === null || value === undefined || value === "") return "";
      return (
        '<div class="row"><span class="k">' +
        escapeHtml(label) +
        "</span><span>" +
        escapeHtml(String(value)) +
        "</span></div>"
      );
    }
    function formatCurrency(v) {
      if (v === null || v === undefined || v === "") return null;
      var n = Number(v);
      if (!Number.isFinite(n)) return v;
      return n.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });
    }
    function showPopup(item, marker) {
      var color = getDestinationColor(item.destinacao);
      var html =
        '<div class="mapPopupCard"><h4>' +
        escapeHtml(item.titulo || "Registro") +
        "</h4>" +
        (item.status
          ? '<div style="margin-bottom:8px"><span class="mapStatusBadge" style="background:' +
            color +
            "22; color:" +
            color +
            '"><span class="mapStatDot" style="background:' +
            color +
            '"></span>' +
            escapeHtml(item.status) +
            "</span></div>"
          : "") +
        rowHtml("Municipio", item.municipio) +
        rowHtml("Modalidade", item.modalidade) +
        rowHtml("Destinacao", item.destinacao) +
        rowHtml("Layer", item.layer) +
        rowHtml("Situacao", item.situacao) +
        rowHtml("Construtora", item.construtora) +
        rowHtml("Gestor", item.gestor) +
        rowHtml("Valor", formatCurrency(item.valor)) +
        rowHtml(
          "Execucao",
          item.percentual_execucao != null && item.percentual_execucao !== ""
            ? item.percentual_execucao + "%"
            : null,
        ) +
        rowHtml("Atualizado em", item.ultima_atualizacao) +
        "</div>";
      marker.bindPopup(html, { closeButton: true, maxWidth: 280 }).openPopup();
    }

    /* ---------------- Filtros (apenas Name, Destinacao e Layer) ---------------- */
    function collectFilterParams() {
      var params = {};
      if ($("mapFilterName").value) params.name = $("mapFilterName").value;
      if ($("mapFilterDestinacao").value)
        params.destinacao = $("mapFilterDestinacao").value;
      if ($("mapFilterLayer").value) params.layer = $("mapFilterLayer").value;
      return params;
    }

    function setState(kind, msg) {
      hideEl("mapLoadingState");
      hideEl("mapErrorState");
      hideEl("mapEmptyState");
      if (kind === "loading") showEl("mapLoadingState");
      else if (kind === "error") {
        $("mapErrorMsg").textContent =
          msg || "Nao foi possivel carregar o mapa.";
        showEl("mapErrorState");
      } else if (kind === "empty") showEl("mapEmptyState");
    }

    function loadData() {
      setState("loading");
      if (abortController) abortController.abort();
      abortController = new AbortController();
      var params = collectFilterParams();
      console.log(
        "[map] Requisitando dados da API /api/mapa com filtros:",
        params,
      );
      var qs = Object.keys(params)
        .map(function (k) {
          return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
        })
        .join("&");
      fetch("/api/mapa" + (qs ? "?" + qs : ""), {
        credentials: "same-origin",
        signal: abortController.signal,
      })
        .then(function (r) {
          return r
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              if (!r.ok) {
                var err = new Error(
                  data.error || "Erro HTTP " + r.status + " ao carregar o mapa",
                );
                err.status = r.status;
                err.data = data;
                throw err;
              }
              return data;
            });
        })
        .then(function (data) {
          lastItems = data.items || [];
          console.log(lastItems);
          console.log(
            "[map] " + lastItems.length + " registro(s) recebido(s) da API.",
          );
          renderPolygonsFromCache();
          renderStats(lastItems);
          renderLegend(lastItems);
          setState(lastItems.length ? "ok" : "empty");
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") {
            console.log(
              "[map] Requisicao anterior abortada (nova requisicao em andamento).",
            );
            return;
          }
          console.error("[map] Falha ao carregar dados do mapa:", err);
          if (err && err.data && err.data.needsConfig) {
            toast(
              "A fonte configurada nao e mais valida. Escolha novamente.",
              "error",
            );
            backToSelect();
            return;
          }
          setState("error", getErrorMessage(err));
        });
      fitToData();
    }

    function renderStats(items) {
      var counts = {};
      items.forEach(function (it) {
        var k = it.status || "Sem status";
        counts[k] = (counts[k] || 0) + 1;
      });
      var html =
        '<div class="mapStatChip"><div class="val">' +
        items.length +
        '</div><div class="lbl">Total</div></div>';
      Object.keys(counts)
        .sort(function (a, b) {
          return counts[b] - counts[a];
        })
        .slice(0, 7)
        .forEach(function (k) {
          html +=
            '<div class="mapStatChip"><div class="val">' +
            counts[k] +
            '</div><div class="lbl"><span class="mapStatDot" style="background:' +
            getDestinationColor(k) +
            '"></span>' +
            escapeHtml(k) +
            "</div></div>";
        });
      $("mapStatsGrid").innerHTML = html;
    }

    function renderLegend(items) {
      // Legenda construida dinamicamente a partir das DESTINACOES presentes
      // nos dados carregados, usando exatamente a mesma funcao de cor dos
      // poligonos (getDestinationColor) -- garante que a cor de cada linha
      // da legenda seja sempre identica a cor do poligono correspondente.
      var seen = {};
      items.forEach(function (it) {
        if (it.destinacao) seen[it.destinacao] = true;
      });
      var keys = Object.keys(seen).sort();
      var html =
        '<strong style="font-size:11px">Legenda &middot; Destinacao</strong>';
      if (!keys.length)
        html +=
          '<div class="small" style="margin-top:4px">Sem dados de destinacao</div>';
      keys.forEach(function (k) {
        html +=
          '<div class="legendRow"><span class="legendDot" style="background:' +
          getDestinationColor(k) +
          '"></span>' +
          escapeHtml(k) +
          "</div>";
      });
      $("mapLegend").innerHTML = html;
    }

    function fillSelect(id, values) {
      if (!values || !values.length) return;
      var el = $(id),
        current = el.value;
      el.innerHTML =
        '<option value="">Todas</option>' +
        values
          .map(function (v) {
            return (
              '<option value="' +
              escapeHtml(v) +
              '">' +
              escapeHtml(v) +
              "</option>"
            );
          })
          .join("");
      el.value = current;
    }
    function loadFilterOptions() {
      console.log("[map] Carregando opcoes de filtro (destinacao, layer)...");
      api("GET", "/api/mapa/filtros")
        .then(function (data) {
          fillSelect("mapFilterDestinacao", data.destinacao);
          fillSelect("mapFilterLayer", data.layer);
          console.log("[map] Opcoes de filtro carregadas com sucesso.");
        })
        .catch(function (err) {
          console.warn(
            "[map] Falha ao carregar opcoes de filtro (nao critico, segue sem elas):",
            getErrorMessage(err),
          );
        });
    }

    function wireFilters() {
      $("mapFilterName").addEventListener(
        "input",
        debounce(function () {
          console.log('[map] Filtro "Name" alterado.');
          loadData();
        }, 450),
      );
      ["mapFilterDestinacao", "mapFilterLayer"].forEach(function (id) {
        $(id).addEventListener("change", function () {
          console.log("[map] Filtro alterado:", id, "=", $(id).value);
          loadData();
        });
      });
      $("mapClearFiltersBtn").addEventListener("click", function () {
        console.log("[map] Limpando todos os filtros.");
        $("mapFilterName").value = "";
        $("mapFilterDestinacao").value = "";
        $("mapFilterLayer").value = "";
        loadData();
      });
      /* "Tentar novamente": por design, executa APENAS o recarregamento dos
       * dados (loadData) -- nunca reinicializa o L.map(). Reinicializar o
       * mapa aqui e o que causava "Map container is already initialized" a
       * cada novo clique. Se o mapa nunca chegou a ser criado (falha grave
       * na inicializacao), orientamos o usuario a reabrir o painel em vez de
       * tentar recriar o mapa por baixo dos panos. */
      $("mapRetryBtn").addEventListener("click", retryLoadData);
    }

    function retryLoadData() {
      console.log(
        '[map] Botao "Tentar novamente" clicado - recarregando apenas os dados (mapa nao e reinicializado).',
      );
      if (!map) {
        var msg =
          "O mapa ainda nao foi inicializado. Volte e selecione novamente a tabela/coluna de localizacao.";
        console.error("[map] " + msg);
        setState("error", msg);
        return;
      }
      loadData();
    }

    function fitToData() {
      if (!map) return;

      var bounds = [];

      polygonLayer.eachLayer(function (layer) {
        if (layer.getBounds) {
          bounds.push(layer.getBounds());
        }
      });

      markerLayer.eachLayer(function (layer) {
        bounds.push(layer.getLatLng());
      });

      if (!bounds.length) return;

      var group = new L.featureGroup([polygonLayer, markerLayer]);

      map.fitBounds(group.getBounds(), {
        padding: [40, 40],
      });
    }

    function wireControls() {
      $("mapZoomInBtn").addEventListener("click", function () {
        map.zoomIn();
      });
      $("mapZoomOutBtn").addEventListener("click", function () {
        map.zoomOut();
      });
      $("mapResetBtn").addEventListener("click", fitToData);
      $("mapFullscreenBtn").addEventListener("click", function () {
        var el = document.querySelector("#mapView .mapMain");
        if (!document.fullscreenElement) {
          if (el.requestFullscreen) el.requestFullscreen();
        } else if (document.exitFullscreen) document.exitFullscreen();
      });
      $("mapLocateBtn").addEventListener("click", function () {
        if (!navigator.geolocation) {
          toast("Geolocalizacao nao suportada neste navegador.", "error");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            map.flyTo([pos.coords.latitude, pos.coords.longitude], 13);
          },
          function (err) {
            console.warn("[map] Falha ao obter geolocalizacao:", err);
            toast("Nao foi possivel obter sua localizacao.", "error");
          },
        );
      });
      $("mapChangeSourceBtn").addEventListener("click", backToSelect);
      $("mapGeocodeInput").addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var q = this.value.trim();
        if (!q) return;
        console.log("[map] Buscando endereco via Nominatim:", q);
        fetch(
          "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
            encodeURIComponent(q),
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (results) {
            if (!results.length) {
              toast("Endereco nao encontrado.", "error");
              return;
            }
            map.flyTo(
              [parseFloat(results[0].lat), parseFloat(results[0].lon)],
              14,
            );
          })
          .catch(function (err) {
            console.warn(
              "[map] Falha ao buscar endereco (Nominatim indisponivel?):",
              err,
            );
            toast("Falha ao buscar endereco.", "error");
          });
      });
    }

    return { enter: enter };
  })();

  /* ==================== INICIALIZACAO ==================== */
  MapModule.enter();
})();
/*
    dados.js
    ---------
    Busca as sessões (Esportes, Eventos, Retratos) através do Cloudflare Worker
    (veja worker.js) e cuida do desbloqueio das galerias com senha. Usado por
    esportes.html, eventos.html, retratos.html, galeria.html e index.html.

    COMO CONFIGURAR A PLANILHA (Google Sheets):
    Cabeçalho na primeira linha:
       slug | categoria | cliente | titulo | local | data | capa | fotos | senha | senha_cifrada

       - slug:      identificador único, sem espaço/acento (ex: corrida-noturna-joao)
       - categoria: exatamente "Esportes", "Eventos" ou "Retratos"
       - cliente, titulo, local, data: textos exibidos no site
       - capa:      link de UMA foto (opcional; sem ele usa a primeira da pasta)
       - fotos:     link de uma PASTA do Google Drive ("Qualquer pessoa com o link -
                    Leitor") ou uma lista de links diretos separados por vírgula
       - senha:     deixe EM BRANCO para uma sessão pública. Para uma sessão privada,
                    cole o código gerado no painel.html (começa com h2$).
       - senha_cifrada: usada só pelo painel.html (guarda a senha do cliente
                    embaralhada, para você poder consultá-la). Cole aqui o outro
                    código que o painel gera.

    COMO A PROTEÇÃO FUNCIONA
    Sessões com senha NÃO são enviadas ao navegador: o Worker remove a linha da
    lista pública. O nome do cliente, o título, a pasta e as fotos só saem quando
    a senha certa chega ao Worker (POST /desbloquear). A senha é conferida lá,
    com um segredo que não está na planilha nem neste site.

    A chave abaixo (DRIVE_API_KEY) serve apenas para listar as pastas das sessões
    PÚBLICAS. Restrinja-a à Google Drive API e ao domínio do site (console.cloud.google.com
    > Credenciais > Restrições). As sessões privadas usam outra chave, guardada no Worker.
*/

// >>> Cole aqui a URL do seu Cloudflare Worker (ver instruções em worker.js) <<<
const SHEET_PROXY_URL = "https://implantar.sheldon-dias23.workers.dev/";
const DRIVE_API_KEY = "AIzaSyB2t5WAuOpt5U6RjolbVGrVIUYdgP97zsw";

// Lê um texto CSV (lidando com campos entre aspas que contêm vírgulas) e
// devolve uma lista de objetos, usando a primeira linha como cabeçalho.
function analisarCsv(texto) {
    const linhas = [];
    let linhaAtual = [];
    let campo = "";
    let dentroAspas = false;

    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        const proximo = texto[i + 1];

        if (dentroAspas) {
            if (c === '"' && proximo === '"') { campo += '"'; i++; }
            else if (c === '"') { dentroAspas = false; }
            else { campo += c; }
            continue;
        }

        if (c === '"') { dentroAspas = true; }
        else if (c === ',') { linhaAtual.push(campo); campo = ""; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && proximo === '\n') i++;
            linhaAtual.push(campo);
            campo = "";
            if (linhaAtual.some(function (v) { return v.trim() !== ""; })) {
                linhas.push(linhaAtual);
            }
            linhaAtual = [];
        } else {
            campo += c;
        }
    }
    if (campo !== "" || linhaAtual.length) {
        linhaAtual.push(campo);
        linhas.push(linhaAtual);
    }

    const cabecalho = linhas.shift().map(function (h) { return h.trim().toLowerCase(); });

    return linhas.map(function (linha) {
        const obj = {};
        cabecalho.forEach(function (chave, indice) {
            obj[chave] = (linha[indice] || "").trim();
        });
        return obj;
    });
}

// Calcula o hash SHA-256 (em hexadecimal) de um texto. Usado para comparar
// a senha digitada pelo cliente com o hash guardado na planilha, sem nunca
// manusear a senha em texto puro.
async function sha256Hex(texto) {
    const bytes = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(function (b) { return b.toString(16).padStart(2, "0"); })
        .join("");
}

// Extrai o ID de uma pasta a partir de um link de pasta do Google Drive.
// Aceita formatos como /drive/folders/ID, /drive/u/0/folders/ID ou ?id=ID.
function extrairIdPastaDrive(link) {
    if (!link) return null;
    let m = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!m) m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}

// Monta a URL de imagem exibível a partir do ID de um arquivo do Drive.
function urlFotoDrive(idArquivo, largura) {
    return "https://drive.google.com/thumbnail?id=" + idArquivo + "&sz=w" + (largura || 1600);
}

// Monta a URL de DOWNLOAD (arquivo original, não a miniatura) a partir do
// ID de um arquivo do Drive.
function urlDownloadDrive(idArquivo) {
    return "https://drive.google.com/uc?export=download&id=" + idArquivo;
}

// Se o link for de um ARQUIVO individual do Drive, devolve {url, download, id}
// prontos para exibir/baixar. Se já for um link direto normal (Cloudinary,
// etc.), usa o próprio link para as duas coisas e id fica null.
function converterLinkDrive(link) {
    if (!link) return { url: link, download: link, id: null };
    let m = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) {
        return { url: urlFotoDrive(m[1], 1600), download: urlDownloadDrive(m[1]), id: m[1] };
    }
    return { url: link, download: link, id: null };
}

// Lista todas as imagens dentro de uma pasta pública do Drive, já com o
// link de exibição, o link de download e o ID de cada uma (o ID é usado
// pelo Worker para buscar o arquivo na hora de montar o zip).
async function buscarFotosDaPasta(idPasta) {
    const consulta = "'" + idPasta + "' in parents and mimeType contains 'image/' and trashed = false";
    const url = "https://www.googleapis.com/drive/v3/files"
        + "?q=" + encodeURIComponent(consulta)
        + "&fields=" + encodeURIComponent("files(id,name)")
        + "&orderBy=name"
        + "&pageSize=1000"
        + "&key=" + DRIVE_API_KEY;

    const resposta = await fetch(url);
    if (!resposta.ok) {
        throw new Error("Não foi possível ler a pasta do Drive (" + resposta.status + ")");
    }

    const dados = await resposta.json();
    const arquivos = dados.files || [];
    return arquivos.map(function (arquivo) {
        return {
            url: urlFotoDrive(arquivo.id, 1600),
            download: urlDownloadDrive(arquivo.id),
            id: arquivo.id,
            nome: arquivo.name
        };
    });
}

// Resolve a lista de fotos de UMA sessão (pasta do Drive ou links diretos)
// e preenche sessao.fotos / sessao.capa. Separado de buscarSessoes() para
// que sessões protegidas por senha só tenham as fotos buscadas depois que
// a senha certa for digitada — antes disso, nenhum link de foto passa
// pelo navegador.
async function resolverFotos(sessao) {
    if (sessao.fotos.length) return sessao.fotos; // já resolvida

    const idPasta = extrairIdPastaDrive(sessao._linkFotos);

    let fotos = [];
    if (idPasta) {
        fotos = await buscarFotosDaPasta(idPasta);
    } else {
        fotos = sessao._linkFotos.split(",")
            .map(function (f) { return f.trim(); })
            .filter(Boolean)
            .map(function (f) { return converterLinkDrive(f); });
    }

    sessao.fotos = fotos;
    if (!sessao.capa) sessao.capa = fotos[0] ? fotos[0].url : "";
    return fotos;
}

// Busca a lista PÚBLICA de sessões (o Worker só envia as sem senha) já com as
// fotos resolvidas. Se por engano uma linha com senha chegar aqui (Worker
// desatualizado), ela vem marcada como protegida e sem fotos — as páginas já
// ignoram sessões protegidas nas listagens.
async function buscarSessoes() {
    if (!SHEET_PROXY_URL || SHEET_PROXY_URL.indexOf("workers.dev") === -1) {
        throw new Error("URL do Worker não configurada em dados.js");
    }

    const resposta = await fetch(SHEET_PROXY_URL, { cache: "no-store" });
    if (!resposta.ok) {
        throw new Error("Não foi possível carregar a planilha (" + resposta.status + ")");
    }

    const texto = (await resposta.text()).replace(/^\uFEFF/, "");
    const linhas = analisarCsv(texto).filter(function (l) { return l.slug; });

    return Promise.all(linhas.map(async function (l) {
        const linkFotos = (l.fotos || "").trim();
        const senha = (l.senha || "").trim();
        const protegida = !!senha;

        const sessao = {
            slug: l.slug,
            categoria: l.categoria || "",
            categoriaHref: (l.categoria || "").toLowerCase() + ".html",
            cliente: l.cliente || "",
            titulo: l.titulo || "",
            local: l.local || "",
            data: l.data || "",
            capa: l.capa ? converterLinkDrive(l.capa).url : "",
            fotos: [],
            senha: "",
            protegida: protegida,
            _linkFotos: protegida ? "" : linkFotos
        };

        if (!protegida) {
            try {
                await resolverFotos(sessao);
            } catch (erro) {
                console.error("Falha ao carregar as fotos da sessão \"" + sessao.slug + "\":", erro);
            }
        }

        return sessao;
    }));
}


// ---------------------------------------------------------------------
// Sessões com senha: tudo passa pelo Worker.
// ---------------------------------------------------------------------

// Endereço do Worker sem barra final nem parâmetros.
function urlBaseWorker() {
    return SHEET_PROXY_URL.split("?")[0].replace(/\/$/, "");
}

// Transforma a resposta do Worker em um objeto de sessão no mesmo formato
// usado pela galeria (fotos com url, download e, para o .zip, proxy).
function prepararSessaoDesbloqueada(d) {
    const base = urlBaseWorker();
    const fotos = (d.fotos || []).map(function (f) {
        if (f.id) {
            return {
                id: f.id,
                nome: f.nome || "",
                url: urlFotoDrive(f.id, 1600),
                download: urlDownloadDrive(f.id),
                proxy: base + "?id=" + encodeURIComponent(f.id) + "&exp=" + f.exp + "&a=" + f.a
            };
        }
        return { id: null, nome: "", url: f.url, download: f.download, proxy: null };
    });

    return {
        slug: d.slug,
        categoria: d.categoria || "",
        categoriaHref: (d.categoria || "").toLowerCase() + ".html",
        cliente: d.cliente || "",
        titulo: d.titulo || "",
        local: d.local || "",
        data: d.data || "",
        capa: d.capa ? converterLinkDrive(d.capa).url : (fotos[0] ? fotos[0].url : ""),
        fotos: fotos,
        senha: "",
        protegida: true,
        exp: d.exp
    };
}

// Pede ao Worker para abrir uma sessão com senha.
//   desbloquearSessao(senha, slug)  → { ok: true, sessao }  |  { ok: false }
//   desbloquearSessao(senha)        → idem; se a mesma senha abrir mais de uma
//                                     sessão, devolve { ok: true, varias: true, sessoes: [{slug, titulo}] }
// Erros de rede/servidor lançam exceção (diferente de "senha errada").
async function desbloquearSessao(senha, slug) {
    const resposta = await fetch(urlBaseWorker() + "/desbloquear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slug ? { senha: senha, slug: slug } : { senha: senha })
    });

    if (resposta.status === 401) return { ok: false };
    if (!resposta.ok) throw new Error("Não foi possível verificar a senha (" + resposta.status + ")");

    const dados = await resposta.json();
    if (dados.varias) return dados;
    return { ok: true, sessao: prepararSessaoDesbloqueada(dados.sessoes[0]) };
}

// Lembra, só nesta aba e só até o acesso expirar, que a sessão foi aberta
// (assim o cliente não precisa digitar a senha de novo ao recarregar).
function guardarSessaoDesbloqueada(sessao) {
    try { sessionStorage.setItem("galeria_acesso_" + sessao.slug, JSON.stringify(sessao)); } catch (e) {}
}

function lerSessaoDesbloqueada(slug) {
    try {
        const texto = sessionStorage.getItem("galeria_acesso_" + slug);
        if (!texto) return null;
        const sessao = JSON.parse(texto);
        if (!sessao || !sessao.exp || sessao.exp < Date.now()) {
            sessionStorage.removeItem("galeria_acesso_" + slug);
            return null;
        }
        return sessao;
    } catch (e) {
        return null;
    }
}

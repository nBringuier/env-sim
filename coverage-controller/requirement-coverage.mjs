/**
 * requirement-coverage.mjs
 *
 * Croise les annotations @requirement dans le code source
 * avec les données de couverture Istanbul pour produire deux CSV :
 *
 *   requirement-details.csv  — une ligne par (exigence × élément annoté)
 *   requirement-summary.csv  — une ligne par exigence avec % de couverture global
 *
 * Convention d'annotation :
 *   TypeScript/JS : // @requirement REQ-001 REQ-002
 *   HTML          : <!-- @requirement REQ-001 REQ-002 -->
 *
 * L'annotation s'applique à l'élément qui commence sur la ligne suivante.
 * Une annotation peut lister plusieurs IDs séparés par des espaces.
 * La même fonction/bloc peut être annotée plusieurs fois (plusieurs exigences).
 */

import fs   from 'node:fs';
import path from 'node:path';

// ─── Regex d'extraction ───────────────────────────────────────────────────────

// Matche : // @requirement REQ-001 REQ-002
//          /* @requirement REQ-001 */
//          <!-- @requirement REQ-001 REQ-002 -->
const ANNOTATION_RE = /(?:\/\/|\/\*|<!--)\s*@requirement\s+([\w\s\-]+?)(?:\*\/|-->|$)/;

// ─── Parser d'annotations ─────────────────────────────────────────────────────

/**
 * Extrait toutes les annotations @requirement d'un fichier source.
 * Retourne un tableau de { lineNumber, requirementIds, elementLine }
 * où elementLine = ligne de l'élément annoté (lineNumber + 1).
 */
function extractAnnotations(sourceContent) {
  const lines       = sourceContent.split('\n');
  const annotations = [];

  lines.forEach((line, idx) => {
    const match = ANNOTATION_RE.exec(line);
    if (!match) return;

    const ids = match[1]
      .trim()
      .split(/\s+/)
      .filter(id => id.length > 0);

    if (!ids.length) return;

    annotations.push({
      annotationLine: idx + 1,          // 1-based
      elementLine:    idx + 2,          // ligne de l'élément qui suit
      requirementIds: ids,
    });
  });

  return annotations;
}

// ─── Résolution de la couverture pour une ligne ───────────────────────────────

/**
 * Pour une ligne donnée dans un fichier Istanbul, trouve la fonction
 * dont la déclaration commence à cette ligne (ou la plus proche après).
 * Retourne { name, covered, callCount } ou null.
 */
function findFunctionAtLine(istanbulEntry, elementLine) {
  const { fnMap, f } = istanbulEntry;
  if (!fnMap) return null;

  // Cherche une fonction dont la déclaration commence à elementLine
  // ou dans les 3 lignes suivantes (tolérance pour les décorateurs Angular)
  for (const [idx, fn] of Object.entries(fnMap)) {
    const fnStartLine = fn.decl?.start?.line ?? fn.loc?.start?.line;
    if (fnStartLine >= elementLine && fnStartLine <= elementLine + 3) {
      return {
        name:      fn.name || '(anonymous)',
        covered:   (f[idx] ?? 0) > 0,
        callCount: f[idx] ?? 0,
      };
    }
  }
  return null;
}

/**
 * Pour une ligne donnée, calcule la couverture des statements
 * qui commencent à cette ligne ou dans les N lignes suivantes.
 * Utilisé pour les blocs HTML et les cas où la fonction n'est pas trouvée.
 */
function findStatementsAtLine(istanbulEntry, elementLine, windowSize = 5) {
  const { statementMap, s } = istanbulEntry;
  if (!statementMap) return null;

  const matching = [];
  for (const [idx, stmt] of Object.entries(statementMap)) {
    const stmtLine = stmt.start?.line;
    if (stmtLine >= elementLine && stmtLine <= elementLine + windowSize) {
      matching.push({ idx, line: stmtLine, count: s[idx] ?? 0 });
    }
  }

  if (!matching.length) return null;

  const covered   = matching.filter(m => m.count > 0).length;
  const callCount = Math.max(...matching.map(m => m.count));
  return {
    name:      `statement@line${elementLine}`,
    covered:   covered > 0,
    callCount,
    stmtTotal: matching.length,
    stmtCovered: covered,
  };
}

// ─── Détection du type d'élément ─────────────────────────────────────────────

function detectElementType(line) {
  if (!line) return 'unknown';
  const t = line.trim();
  if (t.startsWith('<'))                                    return 'html';
  if (/^(export\s+)?(async\s+)?function\s/.test(t))        return 'function';
  if (/^(public|private|protected|async|static).*\(/.test(t)) return 'method';
  if (/^\w+\s*[=(]/.test(t))                               return 'method';
  return 'block';
}

// ─── Génération des CSV ───────────────────────────────────────────────────────

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n'))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvLine(fields) {
  return fields.map(escapeCsv).join(',');
}

/**
 * Point d'entrée principal.
 * @param {object} opts
 * @param {object} opts.sourceContents  - relKey → contenu TypeScript/HTML
 * @param {object} opts.allIstanbulData - relKey → données Istanbul
 * @param {string} opts.reportDir       - dossier de sortie
 */
export async function generateRequirementCsv({ sourceContents, allIstanbulData, reportDir }) {
  // Accumulateurs
  // details : tableau de lignes brutes
  // reqMap  : Map reqId → { elements: [], coveredCount, totalCount }
  const detailRows = [];
  const reqMap     = new Map();

  function ensureReq(id) {
    if (!reqMap.has(id)) reqMap.set(id, { elements: [], total: 0, covered: 0 });
    return reqMap.get(id);
  }

  // Parcourir tous les fichiers sources
  for (const [relKey, content] of Object.entries(sourceContents)) {
    if (!content?.trim()) continue;

    const annotations   = extractAnnotations(content);
    if (!annotations.length) continue;

    const istanbulEntry = allIstanbulData[relKey];
    const lines         = content.split('\n');

    for (const ann of annotations) {
      const elementLine    = ann.elementLine;
      const elementSrcLine = lines[elementLine - 1] || '';
      const elementType    = detectElementType(elementSrcLine);

      // Résolution de la couverture
      let coverage = null;
      if (istanbulEntry) {
        // Essai 1 : chercher une fonction/méthode à cette ligne
        coverage = findFunctionAtLine(istanbulEntry, elementLine);
        // Essai 2 : fallback sur les statements (HTML, blocs, etc.)
        if (!coverage) {
          coverage = findStatementsAtLine(istanbulEntry, elementLine);
        }
      }

      const elementName  = coverage?.name ?? elementSrcLine.trim().slice(0, 60);
      const covered      = coverage?.covered ?? false;
      const callCount    = coverage?.callCount ?? 0;
      const stmtInfo     = coverage?.stmtTotal
        ? `${coverage.stmtCovered}/${coverage.stmtTotal}`
        : '';

      for (const reqId of ann.requirementIds) {
        const req = ensureReq(reqId);
        req.total++;
        if (covered) req.covered++;

        req.elements.push({
          file:        relKey,
          line:        elementLine,
          type:        elementType,
          name:        elementName,
          covered,
          callCount,
          stmtInfo,
        });

        detailRows.push([
          reqId,
          relKey,
          elementType,
          elementName,
          elementLine,
          covered ? 'OUI' : 'NON',
          callCount,
          stmtInfo,
        ]);
      }
    }
  }

  // ── CSV details ─────────────────────────────────────────────────────────────
  const detailsPath = path.join(reportDir, 'requirement-details.csv');
  const detailHeader = toCsvLine([
    'requirement_id', 'fichier', 'type_element', 'nom_element',
    'ligne', 'couverte', 'nb_appels', 'statements_couverts',
  ]);
  const detailsContent = [
    detailHeader,
    ...detailRows.map(r => toCsvLine(r)),
  ].join('\n');
  fs.writeFileSync(detailsPath, '\uFEFF' + detailsContent); // BOM UTF-8 pour Excel

  // ── CSV summary ─────────────────────────────────────────────────────────────
  const summaryPath = path.join(reportDir, 'requirement-summary.csv');
  const summaryHeader = toCsvLine([
    'requirement_id', 'elements_total', 'elements_couverts',
    'couverture_pct', 'statut',
  ]);

  const summaryRows = [...reqMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { total, covered }]) => {
      const pct    = total > 0 ? Math.round((covered / total) * 100) : 0;
      const statut = pct === 100 ? 'OK' : pct === 0 ? 'NOK' : 'PARTIEL';
      return toCsvLine([id, total, covered, `${pct}%`, statut]);
    });

  const summaryContent = [summaryHeader, ...summaryRows].join('\n');
  fs.writeFileSync(summaryPath, '\uFEFF' + summaryContent);

  return {
    details: detailsPath,
    summary: summaryPath,
    requirementCount: reqMap.size,
  };
}

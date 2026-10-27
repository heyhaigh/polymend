// Make the guide pages (glb-to-stl.html, non-manifold-edges.html, bambu-studio-open-edges.html)
// and the Guides page that lists them (guides.html),
// one page for each question people ask about printing a model. The visible text and the
// page's structured data are made from the same entries below, so they cannot disagree.
// A test fails if a page is out of date.
// Usage: node tools/make-guides.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Guide text is written here with a few inline tags (<strong>, <code>, <a>). Structured data
// carries the same sentences with the tags removed.
const plain = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const longDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const guides = [
  {
    file: 'glb-to-stl.html',
    slug: '/glb-to-stl',
    title: 'Convert GLB to STL for 3D printing',
    link: 'Convert GLB to STL',
    description: 'How to convert a GLB file to an STL or 3MF you can print, free and in your browser: turn it upright, set its height in millimeters and fix the mesh faults slicers flag.',
    published: '2026-10-27',
    updated: '2026-10-27',
    answer: 'Drop the GLB on <a href="/">Polymend</a>. It turns the model upright, lets you set its print height in millimeters, repairs the small mesh faults a slicer would flag, and gives you an STL, a 3MF or both. It is free, it runs in your browser, and the file is never uploaded. Color and texture are not kept, since an STL holds shape only.',
    sections: [
      {
        heading: 'Why a GLB needs converting',
        paragraphs: [
          'A GLB is a binary glTF file, made for showing 3D models on screens. Slicers prefer STL or 3MF, and a GLB that is renamed or exported carelessly tends to arrive wrong in three ways:',
        ],
        list: [
          '<strong>Size.</strong> glTF measures in meters, while an STL has no units and slicers read it as millimeters. A 20 cm figure can arrive 0.2 mm tall.',
          '<strong>Direction.</strong> glTF treats Y as up; printers treat Z as up. Unturned, a standing figure lies on its back.',
          '<strong>Mesh faults.</strong> Models made for screens often carry small holes, stray triangles and reversed faces. A screen does not mind them; a slicer reports them as open edges, non-manifold edges and reversed faces.',
        ],
      },
      {
        heading: 'How to convert it with Polymend',
        steps: [
          'Open <a href="/">polymend.xyz</a> and drop in one GLB, or up to 20 at once.',
          'Check the model before and after, side by side. Every change is marked, and you can step through them one at a time.',
          'Under Size, set the print height in millimeters.',
          'Download an STL, a 3MF, or a ZIP with both.',
        ],
        after: 'A detailed figure of 300,000 triangles takes about a second. Files up to 200 MB or 1 million triangles work on a laptop.',
      },
      {
        heading: 'GLB files that need a little more',
        list: [
          '<strong>Draco-compressed GLB</strong> files, which many museums and model sites publish, are unpacked automatically.',
          '<strong>Meshopt-compressed GLB</strong> files are not supported yet. Export them again uncompressed.',
          '<strong>Rigged or animated GLB</strong> files are read in their rest pose. If the file has animation clips, you can choose any moment of a clip and repair that pose instead.',
        ],
      },
    ],
    faq: [
      {
        q: 'Can I convert GLB to STL without uploading the file?',
        a: 'Yes. Polymend reads and converts the file in your browser. The page carries a security policy that tells your browser to block it from opening any network connection, and the code is open source, so this can be checked.',
      },
      {
        q: 'Should I use STL or 3MF?',
        a: 'Either works in most slicers. A 3MF records its units, so it always opens at the size you set. An STL has no units, and slicers assume millimeters, which is what Polymend writes.',
      },
      {
        q: 'Why is my converted model tiny in the slicer?',
        a: 'The GLB was measured in meters and the slicer read the numbers as millimeters, so a model 0.2 m tall became 0.2 mm. Setting a print height in Polymend before you download writes the model at that size.',
      },
      {
        q: 'Can I convert GLB to STL in Blender instead?',
        a: 'Yes: import the glTF file, then export it as STL, setting the scale and turning it upright yourself. Blender does not repair the mesh on export, so a slicer may still report open or non-manifold edges.',
      },
    ],
  },
  {
    file: 'non-manifold-edges.html',
    slug: '/non-manifold-edges',
    title: 'How to fix non-manifold edges in an STL',
    link: 'Fix non-manifold edges',
    description: 'What non-manifold edges and open edges are, why a slicer warns about them, and how to fix them in an STL or GLB file for free in your browser.',
    published: '2026-10-27',
    updated: '2026-10-27',
    answer: 'A non-manifold edge is shared by three or more triangles, so a slicer cannot tell the inside of the model from the outside. Usually the cause is a stray triangle stuck to the surface or a small hole beside it. Drop the STL or GLB on <a href="/">Polymend</a>: it removes stray triangles, patches small holes and turns reversed faces, then gives you back an STL or 3MF. It is free and runs in your browser.',
    sections: [
      {
        heading: 'What non-manifold and open edges are',
        paragraphs: [
          'A printable model is a closed surface where every edge is shared by exactly two triangles, one on each side. Two faults break that rule:',
        ],
        list: [
          '<strong>An open edge</strong> belongs to only one triangle, so there is a gap beside it. A ring of open edges is a hole.',
          '<strong>A non-manifold edge</strong> is shared by three or more triangles. The surface branches there, so there is no single inside.',
        ],
        after: 'Triangles facing the wrong way, called reversed faces, usually come with them. A model can look perfect on screen and still carry dozens of these faults.',
      },
      {
        heading: 'How to fix them with Polymend',
        steps: [
          'Open <a href="/">polymend.xyz</a> and drop in the STL or GLB.',
          'Polymend removes stray triangles stuck to the surface, patches holes of up to 100 edges and turns triangles that face the wrong way.',
          'Compare before and after side by side, and step through each change.',
          'Download the repaired STL or 3MF and open it in your slicer.',
        ],
        after: 'In testing, twelve detailed figures each had 6 to 54 non-manifold edges and 16 to 114 open edges. Polymend brought all twelve to zero, and all twelve then passed the mesh checks of Bambu Studio and a second slicer.',
      },
      {
        heading: 'What it leaves alone',
        paragraphs: [
          'Polymend is built for small faults and changes as little as it can. It does not fill holes larger than 100 edges, wide openings that may be meant (like the top of a vase), thin sheets with no thickness, or badly damaged scans. When something is left, the result says "Partly repaired". For those models, a 3D editor such as Blender will do better: in Edit Mode, Select, Select All by Trait, Non Manifold shows every fault so you can fix it by hand.',
        ],
      },
    ],
    faq: [
      {
        q: 'Will a non-manifold model still print?',
        a: 'Sometimes. Many slicers try to close small faults themselves, but the result can have missing layers, gaps in walls or stray strands. Fixing the mesh first removes the guesswork.',
      },
      {
        q: 'Does fixing non-manifold edges change my model?',
        a: 'Very little. Polymend deletes stray triangles, usually a few dozen out of hundreds of thousands, and adds a few to patch small holes. No existing point is moved, except that points a hair apart on the two sides of a seam are joined. A model with no faults is left exactly as it is.',
      },
      {
        q: 'Is it free?',
        a: 'Yes. Polymend is free to use and open source under the MIT license.',
      },
    ],
  },
  {
    file: 'bambu-studio-open-edges.html',
    slug: '/bambu-studio-open-edges',
    title: 'Fix the open edges warning in Bambu Studio',
    link: 'Bambu Studio open edges warning',
    description: 'Why Bambu Studio warns about open edges, non-manifold edges and reversed faces when you import a model, and how to fix the file for free so it imports without the warning.',
    published: '2026-10-27',
    updated: '2026-10-27',
    answer: 'Bambu Studio warns when the model\'s mesh has gaps (open edges), places where the surface branches (non-manifold edges) or triangles facing the wrong way (reversed faces). Drop the STL or GLB on <a href="/">Polymend</a>, download the repaired STL or 3MF, and import that instead. In testing, twelve figures that all triggered the warning imported into Bambu Studio without it after repair.',
    sections: [
      {
        heading: 'What the warning means',
        paragraphs: [
          'Bambu Studio checks every model it imports. A printable model is a closed surface where every edge is shared by exactly two triangles. When it finds edges with only one triangle, edges shared by three or more, or triangles turned inside out, it reports them as errors. Detailed sculpted figures and 3D scans are the models that most often carry them, even when they look finished.',
        ],
      },
      {
        heading: 'How to fix the file',
        steps: [
          'Open <a href="/">polymend.xyz</a> and drop in the STL or GLB you were importing.',
          'Under Size, set the print height in millimeters if you want one.',
          'Download the repaired STL or 3MF.',
          'Import the repaired file into Bambu Studio.',
        ],
        after: 'The repair runs in your browser and the file is never uploaded. A figure of 300,000 triangles takes about a second.',
      },
      {
        heading: 'If the warning remains',
        paragraphs: [
          'If Polymend says "Partly repaired", the model has faults larger than it fixes on purpose, such as wide holes or thin sheets with no thickness. On Windows, Bambu Studio\'s own Fix Model command (right-click the model) may help; otherwise a 3D editor such as Blender will do better.',
        ],
      },
    ],
    faq: [
      {
        q: 'Why does Bambu Studio say the 3MF is not from Bambu Lab?',
        a: 'That notice is expected and is not an error. Polymend\'s 3MF holds only the model, at the size you set, not a Bambu Studio project, so Bambu Studio loads the geometry and uses your own printer and filament settings.',
      },
      {
        q: 'Can I ignore the open edges warning?',
        a: 'For a few edges on a simple part, often yes; Bambu Studio may slice it anyway. On detailed models the faults can show up as gaps or missing layers, so it is safer to repair the file first.',
      },
      {
        q: 'What are the dark flecks in the slicer preview after repair?',
        a: 'Places where the surface passes through itself. Polymend counts them but does not change them, since fixing one means re-sculpting the surface. They are not holes, they bring no warning, and they print as solid.',
      },
    ],
  },
];

function section(s) {
  const out = [`      <h2>${escape(s.heading)}</h2>`];
  for (const p of s.paragraphs || []) out.push(`      <p>${p}</p>`);
  if (s.list) out.push('      <ul>', ...s.list.map(item => `        <li>${item}</li>`), '      </ul>');
  if (s.steps) out.push('      <ol>', ...s.steps.map(item => `        <li>${item}</li>`), '      </ol>');
  if (s.after) out.push(`      <p>${s.after}</p>`);
  return out.join('\n');
}

function structuredData(g) {
  const url = 'https://polymend.xyz' + g.slug;
  const howTo = g.sections.find(s => s.steps);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': url + '#article',
        headline: g.title,
        description: g.description,
        abstract: plain(g.answer),
        url,
        mainEntityOfPage: url,
        datePublished: g.published,
        dateModified: g.updated,
        inLanguage: 'en-US',
        image: 'https://polymend.xyz/og-image.jpg',
        author: { '@type': 'Person', '@id': 'https://heyhaigh.ai/#person', name: 'Ryan Haigh', url: 'https://heyhaigh.ai' },
        about: { '@id': 'https://polymend.xyz/#app' },
      },
      {
        '@type': 'HowTo',
        '@id': url + '#howto',
        name: howTo.heading,
        tool: { '@type': 'HowToTool', name: 'Polymend', url: 'https://polymend.xyz/' },
        step: howTo.steps.map((text, i) => ({ '@type': 'HowToStep', position: i + 1, text: plain(text) })),
      },
      {
        '@type': 'FAQPage',
        '@id': url + '#faq',
        mainEntity: g.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: plain(a) } })),
      },
    ],
  };
}

export const guidesIndex = {
  file: 'guides.html',
  slug: '/guides',
  title: 'Guides',
  description: 'Guides to getting a 3D model ready to print: converting GLB to STL, fixing non-manifold edges, and clearing the open edges warning in Bambu Studio.',
};

export function guidesIndexPage() {
  const g = guidesIndex;
  const body = `      <h1 class="tool-title">Guides</h1>
      <p class="prose-lede">Short guides to the problems that stop a 3D model from printing, and how to fix each one with Polymend.</p>
      <ul>
${guides.map(o => `        <li><a href="${o.slug}">${escape(o.title)}</a>: ${escape(o.description)}</li>`).join('\n')}
      </ul>`;
  const data = { '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': 'https://polymend.xyz/guides#page', name: 'Polymend guides', url: 'https://polymend.xyz/guides', description: g.description, hasPart: guides.map(o => ({ '@type': 'TechArticle', '@id': `https://polymend.xyz${o.slug}#article`, headline: o.title, url: 'https://polymend.xyz' + o.slug })) };
  return shell({ ...g, type: 'website', data, body });
}

export function guidePage(g) {
  const others = guides.filter(other => other !== g);
  const body = `      <h1 class="tool-title">${escape(g.title)}</h1>
      <p class="tool-meta"><span class="meta-text">Updated <time datetime="${g.updated}">${longDate(g.updated)}</time></span></p>
      <p class="prose-lede">${g.answer}</p>

${g.sections.map(section).join('\n\n')}

      <h2>Questions</h2>
${g.faq.map(({ q, a }) => `      <h3>${escape(q)}</h3>\n      <p>${a}</p>`).join('\n')}

      <p class="guide-cta"><a href="/">Open Polymend</a></p>

      <h2>More guides</h2>
      <ul>
${others.map(o => `        <li><a href="${o.slug}">${escape(o.title)}</a></li>`).join('\n')}
      </ul>`;
  return shell({ ...g, type: 'article', data: structuredData(g), body });
}

function shell(g) {
  const url = 'https://polymend.xyz' + g.slug;
  return `<!doctype html>
<!-- Made by tools/make-guides.mjs. Do not edit this file. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(g.title)} · Polymend</title>
  <meta name="description" content="${escape(g.description)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="${g.type}">
  <meta property="og:site_name" content="Polymend">
  <meta property="og:title" content="${escape(g.title)} · Polymend">
  <meta property="og:description" content="${escape(g.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="https://polymend.xyz/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Polymend. A 3D figure shown before and after repair, with the repaired spots marked.">
${g.type === 'article' ? `  <meta property="article:published_time" content="${g.published}">
  <meta property="article:modified_time" content="${g.updated}">
` : ''}  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://polymend.xyz/og-image.jpg">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="Polymend for language models">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <link rel="preload" href="/app/fonts/GeistMono-Variable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/app/style.css">
  <script src="/app/theme.js"></script>
  <script type="application/ld+json">${JSON.stringify(g.data).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <div class="controls-group">
    <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle theme (T)"></button>
  </div>
  <main class="tool-container">
    <article class="prose">
      <p class="prose-back"><a href="/">Polymend</a></p>
${g.body}
    </article>
    <nav class="site-links" aria-label="About this site">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/changelog">Changelog</a>
      <a href="/guides">Guides</a>
      <a href="mailto:feedback@polymend.xyz?subject=Polymend%20feedback">Send feedback</a>
      <a href="https://github.com/heyhaigh/polymend">GitHub</a>
      <a href="/#embed">Embed on your site</a>
    </nav>
    <p class="credit">
      <a href="https://heyhaigh.ai/">
        <img src="/app/ry-hand-96.webp" alt="" width="32" height="32">
        <span>Created by Ryan Haigh</span>
      </a>
    </p>
  </main>
</body>
</html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const g of guides) fs.writeFileSync(path.join(root, g.file), guidePage(g));
  fs.writeFileSync(path.join(root, guidesIndex.file), guidesIndexPage());
  console.log([...guides, guidesIndex].map(g => g.file).join(', ') + ' written');
}

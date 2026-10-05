"""Independent check of repaired files with trimesh, and comparison with another tool's repairs."""
import sys, os, glob, json
import numpy as np, trimesh
from collections import Counter
from scipy.spatial import cKDTree

def stats(path):
    m = trimesh.load(path, process=False, force='mesh')
    m.merge_vertices()
    e = np.sort(m.edges, axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    c = Counter(counts.tolist())
    parts = trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)))
    return m, dict(tris=len(m.faces), open=c.get(1, 0), bad=sum(v for k, v in c.items() if k > 2),
                   watertight=bool(m.is_watertight), winding=bool(m.is_winding_consistent),
                   shells=sorted((len(p) for p in parts), reverse=True)[:4], volume=float(m.volume))

pairs = json.loads(sys.argv[1])
ok = True
for original, other in pairs:
    name = os.path.basename(original)
    mended = os.path.join('out', name[:-4] + '_mended.stl')
    mo, so = stats(original); mm, sm = stats(mended)
    good = sm['open'] == 0 and sm['bad'] == 0 and sm['watertight'] and sm['winding'] and sm['volume'] > 0
    ok &= good
    tree = cKDTree(mo.vertices)
    d, _ = tree.query(mm.vertices)
    line = f"{'PASS' if good else 'FAIL'} {name:34s} open {sm['open']} bad {sm['bad']} watertight {sm['watertight']} winding {sm['winding']} shells {sm['shells']} vol {sm['volume']/abs(so['volume'])-1:+.5%} moved-verts {(d > 1e-9).sum()}"
    if other:
        mf, sf = stats(other)
        df, _ = tree.query(mf.vertices)
        line += f"  | other tool: shells {sf['shells']} tris {sf['tris']} (ours {sm['tris']}) vol {sf['volume']/abs(so['volume'])-1:+.5%} moved-verts {(df > 1e-6).sum()} max-shift {df.max()/mo.extents.max():.3%} of size"
    print(line)
print('\nALL PASS' if ok else '\nFAILURES')
sys.exit(0 if ok else 1)

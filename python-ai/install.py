#!/usr/bin/env python3
"""StockDesk v1.9 optional AI installer.
User-initiated only: creates an isolated venv under ~/.stockdesk/ai-engine,
downloads the official upstream source/weights, and writes an install manifest.
"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys, tempfile, urllib.request, venv, zipfile
from pathlib import Path

KRONOS = {
    "kronos-mini": ("NeoQuasar/Kronos-mini", "NeoQuasar/Kronos-Tokenizer-2k"),
    "kronos-small": ("NeoQuasar/Kronos-small", "NeoQuasar/Kronos-Tokenizer-base"),
    "kronos-base": ("NeoQuasar/Kronos-base", "NeoQuasar/Kronos-Tokenizer-base"),
}
MASTER = {
    "master-csi300": "model/csi300_opensource_0.pkl",
    "master-csi800": "model/csi800_opensource_0.pkl",
}

def emit(stage, message, progress=None, **extra):
    row = {"type":"progress", "stage":stage, "message":message}
    if progress is not None: row["progress"] = progress
    row.update(extra)
    print(json.dumps(row, ensure_ascii=False), flush=True)

def venv_python(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

def safe_extract(zf: zipfile.ZipFile, target: Path):
    root = target.resolve()
    for info in zf.infolist():
        dest = (target / info.filename).resolve()
        if root not in dest.parents and dest != root:
            raise RuntimeError("unsafe zip path")
    zf.extractall(target)

def download_zip(url: str, target_dir: Path, final_name: str):
    if target_dir.exists() and any(target_dir.iterdir()):
        return
    emit("source", f"下载官方源码：{url}")
    with tempfile.TemporaryDirectory() as td:
        zpath = Path(td) / "repo.zip"
        urllib.request.urlretrieve(url, zpath)
        ex = Path(td) / "extract"; ex.mkdir()
        with zipfile.ZipFile(zpath) as zf: safe_extract(zf, ex)
        roots = [x for x in ex.iterdir() if x.is_dir()]
        if not roots: raise RuntimeError("源码压缩包结构异常")
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(roots[0]), str(target_dir))
    emit("source", f"已准备 {final_name} 官方源码")

def pip_install(py: Path, packages):
    cmd = [str(py), "-m", "pip", "install", "--upgrade"] + list(packages)
    emit("deps", "安装本地AI依赖（首次可能较慢）", 20)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    for line in p.stdout or []:
        line=line.strip()
        if line: print(json.dumps({"type":"log","message":line[-500:]},ensure_ascii=False),flush=True)
    if p.wait()!=0: raise RuntimeError("pip 依赖安装失败")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--model", required=True, choices=list(KRONOS)+list(MASTER))
    args=ap.parse_args()
    home=Path(args.home).expanduser().resolve(); home.mkdir(parents=True, exist_ok=True)
    vdir=home/"venv"; vendor=home/"vendor"; models=home/"models"; models.mkdir(exist_ok=True); vendor.mkdir(exist_ok=True)
    manifest_path=home/"install-manifest.json"
    manifest={"schemaVersion":1,"models":[]}
    if manifest_path.exists():
        try: manifest=json.loads(manifest_path.read_text("utf-8"))
        except Exception: pass
    emit("prepare", f"准备安装 {args.model}", 5)
    if not venv_python(vdir).exists():
        emit("venv", "创建隔离 Python 环境", 10)
        venv.EnvBuilder(with_pip=True, clear=False).create(vdir)
    py=venv_python(vdir)
    # Upstream Kronos currently requires torch/numpy/pandas/einops/huggingface_hub/safetensors/tqdm.
    # River is StockDesk's fast online-calibration/drift layer.
    pip_install(py, [
        "numpy>=1.26", "pandas>=2.0", "torch>=2.0", "einops==0.8.1",
        "huggingface_hub==0.33.1", "safetensors==0.6.2", "tqdm>=4.67",
        "river>=0.22", "psutil>=5.9"
    ])
    if args.model in KRONOS:
        download_zip("https://codeload.github.com/shiyu-coder/Kronos/zip/refs/heads/master", vendor/"Kronos", "Kronos")
        emit("weights", "下载 Kronos 官方公开权重", 55)
        code = "from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1],local_dir=sys.argv[2]); snapshot_download(repo_id=sys.argv[3],local_dir=sys.argv[4])"
        mid, tid=KRONOS[args.model]
        mdir=models/args.model; tdir=models/("tokenizer-2k" if "2k" in tid else "tokenizer-base")
        subprocess.run([str(py),"-c",code,mid,str(mdir),tid,str(tdir)],check=True)
    else:
        download_zip("https://codeload.github.com/SJTU-DMTai/MASTER/zip/refs/heads/master", vendor/"MASTER", "MASTER")
        ck=vendor/"MASTER"/MASTER[args.model]
        if not ck.exists() or ck.stat().st_size < 1024:
            raise RuntimeError("MASTER公开checkpoint未完整下载；可能受Git LFS/网络限制，请稍后重试或手动放置官方checkpoint。")
        emit("weights", f"已校验 MASTER checkpoint：{ck.name}", 75)
    mods=set(manifest.get("models") or []); mods.add(args.model)
    manifest.update({"schemaVersion":1,"models":sorted(mods),"python":str(py),"lastInstalled":args.model})
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),"utf-8")
    (home/"checkpoints").mkdir(exist_ok=True); (home/"feature_store").mkdir(exist_ok=True); (home/"online").mkdir(exist_ok=True)
    emit("done", f"{args.model} 安装完成", 100, model=args.model)

if __name__=="__main__":
    try: main()
    except Exception as e:
        print(json.dumps({"type":"error","message":str(e)},ensure_ascii=False),flush=True)
        raise

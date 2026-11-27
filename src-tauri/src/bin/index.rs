//! 掃描工具：列出目錄下所有 .bundle 的組成。
//!
//! 用法：
//! ```text
//! cargo run --release --features research-tools --bin index -- <bundle 目錄> [--dump-text <outdir>] [--dump-mono <outdir>]
//! ```
//! - 預設：每個 bundle 印出 SerializedFile 數量、各 classID 物件統計、
//!   AssetBundle m_Container 筆數（附前 3 筆路徑樣本）、總解壓大小。
//! - `--dump-text`：TextAsset 原樣輸出成 `<outdir>/<bundle名>/<m_Name>.json`。
//! - `--dump-mono`：MonoBehaviour payload 輸出成 `<outdir>/<bundle名>/<m_Name>.bin`
//!   （Phase 2 的 WZJS fixture 素材）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use msclassic::unity::bundle::Bundle;
use msclassic::unity::objects;
use msclassic::unity::serialized_file::{metadata_len, SerializedFile, HEADER_SIZE};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("用法: index <bundle 目錄> [--dump-text <outdir>] [--dump-mono <outdir>]");
        std::process::exit(1);
    }
    let dir = PathBuf::from(&args[0]);
    let mut dump_text: Option<PathBuf> = None;
    let mut dump_mono: Option<PathBuf> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--dump-text" => {
                dump_text = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--dump-mono" => {
                dump_mono = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            other => {
                eprintln!("未知參數: {other}");
                std::process::exit(1);
            }
        }
    }

    // 收集 .bundle 檔，按檔名排序讓輸出穩定
    let mut bundles: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "bundle"))
        .collect();
    bundles.sort();
    println!("掃描目錄: {}（{} 個 bundle）", dir.display(), bundles.len());

    let mut ok_count = 0;
    for path in &bundles {
        match scan_bundle(path, dump_text.as_deref(), dump_mono.as_deref()) {
            Ok(()) => ok_count += 1,
            Err(e) => println!("!! {} 解析失敗: {e}", path.display()),
        }
    }
    println!("\n完成：{ok_count}/{} 個 bundle 掃描成功", bundles.len());
    Ok(())
}

fn scan_bundle(
    path: &Path,
    dump_text: Option<&Path>,
    dump_mono: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
    let bundle = Bundle::open(path)?;
    let serialized_nodes: Vec<usize> = bundle
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.is_serialized_file())
        .map(|(i, _)| i)
        .collect();

    println!("\n=== {stem} ===");
    println!(
        "  nodes: {}（{} 個 SerializedFile），解壓後總大小 {:.1} MB",
        bundle.nodes.len(),
        serialized_nodes.len(),
        bundle.decompressed_size() as f64 / 1e6
    );

    for &ni in &serialized_nodes {
        let node = &bundle.nodes[ni];
        // 只讀 header + metadata，不解整個 node
        let head48 = bundle.read_node_range(ni, 0, HEADER_SIZE)?;
        let meta_len = metadata_len(&head48)?;
        let head = bundle.read_node_range(ni, 0, meta_len)?;
        let sf = SerializedFile::parse(&head)?;

        // classID 統計
        let mut stats: BTreeMap<i32, usize> = BTreeMap::new();
        for o in &sf.objects {
            *stats.entry(o.class_id).or_default() += 1;
        }
        let stats_str: Vec<String> = stats.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        println!(
            "  [{}] unity {} / objects {} / {{{}}}",
            node.name,
            sf.unity_version,
            sf.objects.len(),
            stats_str.join(", ")
        );

        // 讀取單一物件 bytes 的 closure
        let read_obj = |o: &msclassic::unity::serialized_file::ObjectInfo| -> msclassic::unity::Result<Vec<u8>> {
            bundle.read_node_range(ni, sf.data_offset + o.byte_start as u64, o.byte_size as usize)
        };

        // AssetBundle(142)：m_Container 捷徑
        for o in sf.objects_by_class(objects::CLASS_ASSET_BUNDLE) {
            let info = objects::parse_asset_bundle(&read_obj(o)?, &sf)?;
            let samples: Vec<&str> = info
                .container
                .iter()
                .take(3)
                .map(|e| e.path.as_str())
                .collect();
            println!(
                "    AssetBundle {:?}: m_Container {} 筆，樣本 {:?}",
                info.name,
                info.container.len(),
                samples
            );
        }

        // Texture2D(28)：驗證欄位對齊（寬高 / 格式要合理）
        let mut tex_count = 0;
        for o in sf.objects_by_class(objects::CLASS_TEXTURE2D) {
            let info = objects::parse_texture2d(&read_obj(o)?, &sf)?;
            if tex_count < 5 {
                println!(
                    "    Texture2D {:?}: {}x{} fmt={} mip={} completeImageSize={} stream=({},{} {:?})",
                    info.name, info.width, info.height, info.texture_format, info.mip_count,
                    info.complete_image_size, info.stream_offset, info.stream_size, info.stream_path
                );
            }
            tex_count += 1;
        }
        if tex_count > 5 {
            println!("    ...共 {tex_count} 個 Texture2D");
        }

        // --dump-text：TextAsset → .json
        if let Some(outdir) = dump_text {
            let dir = outdir.join(&stem);
            std::fs::create_dir_all(&dir)?;
            let mut used = std::collections::HashSet::new();
            for o in sf.objects_by_class(objects::CLASS_TEXT_ASSET) {
                let ta = objects::parse_text_asset(&read_obj(o)?, &sf)?;
                let fname = unique_name(&ta.name, o.path_id, "json", &mut used);
                std::fs::write(dir.join(fname), &ta.script)?;
            }
        }

        // --dump-mono：MonoBehaviour payload → .bin
        if let Some(outdir) = dump_mono {
            let dir = outdir.join(&stem);
            std::fs::create_dir_all(&dir)?;
            let mut used = std::collections::HashSet::new();
            for o in sf.objects_by_class(objects::CLASS_MONO_BEHAVIOUR) {
                let data = read_obj(o)?;
                let mb = objects::parse_mono_behaviour(&data, &sf)?;
                let fname = unique_name(&mb.name, o.path_id, "bin", &mut used);
                std::fs::write(dir.join(fname), &data[mb.header_len..])?;
            }
        }
    }
    Ok(())
}

/// 檔名消毒 + 空名 fallback + 重名加 path_id 後綴（Windows 不合法字元換成 `_`）。
fn unique_name(
    name: &str,
    path_id: i64,
    ext: &str,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let base: String = name
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let base = if base.is_empty() {
        format!("pathid_{path_id}")
    } else {
        base
    };
    // Windows 檔案系統大小寫不敏感，重名判斷也要不分大小寫
    let fname = if used.contains(&base.to_lowercase()) {
        format!("{base}_{path_id}")
    } else {
        base
    };
    used.insert(fname.to_lowercase());
    format!("{fname}.{ext}")
}

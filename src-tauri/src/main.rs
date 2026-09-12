#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{ffi::OsStr, io::{BufRead, BufReader, Read, Write}, process::{Child, Command, Stdio}, sync::{Arc,Mutex}};
use tauri::{Emitter, Manager};
use serde_json::{json, Value};

#[derive(Default)]
struct Jobs(Arc<Mutex<Option<(String,Child)>>>);
fn stop(jobs:&Jobs) {
    if let Ok(mut slot)=jobs.0.lock() {
        if let Some((_,mut child))=slot.take() { let _=child.kill(); let _=child.wait(); }
    }
}
#[tauri::command]
fn cancel_job(jobs:tauri::State<Jobs>) { stop(&jobs); }

#[tauri::command]
fn start_job(app:tauri::AppHandle,jobs:tauri::State<Jobs>,request:Value)->Result<(),String>{
    let id=request.get("job_id").and_then(Value::as_str).ok_or("Missing job ID")?.to_string();
    if id.len()>100 || request.to_string().len()>300_000 { return Err("Request too large".into()); }
    let mut slot=jobs.0.lock().map_err(|e|e.to_string())?;
    if slot.is_some(){ return Err("A job is already running".into()); }
    let mut command;
    if cfg!(debug_assertions) {
        let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let python=if cfg!(target_os="windows"){root.join(".venv/Scripts/python.exe")}else{root.join(".venv/bin/python")};
        command=Command::new(python);
        command.arg(root.join("backend/worker.py"));
    } else {
        let worker=if cfg!(target_os="windows"){"promoter-atlas-worker.exe"}else{"promoter-atlas-worker"};
        let executable=app.path().resource_dir().map_err(|e|e.to_string())?.join("resources/backend").join(worker);
        command=Command::new(executable);
    }
    let mut child=command.env("OMP_NUM_THREADS","2").env("PYTHONDONTWRITEBYTECODE","1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let mut input=child.stdin.take().unwrap();
    if let Err(error)=writeln!(input,"{}",request) { let _=child.kill(); let _=child.wait(); return Err(error.to_string()); }
    drop(input);
    let stdout=child.stdout.take().unwrap();
    let stderr=child.stderr.take().unwrap();
    let errors=Arc::new(Mutex::new(String::new()));
    let captured=errors.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut log)=captured.lock(){ if log.len()<16000 { log.push_str(&line); log.push('\n'); } }
        }
    });
    *slot=Some((id.clone(),child));
    drop(slot);
    let state=jobs.0.clone();
    std::thread::spawn(move || {
        let mut terminal=false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.len()>15_000_000 {break;}
            if let Ok(message)=serde_json::from_str::<Value>(&line) {
                if message["job_id"]!=id || message["protocol"]!=1 {continue;}
                let active=state.lock().map(|s|s.as_ref().map(|(i,_)|i==&id).unwrap_or(false)).unwrap_or(false);
                if !active {break;}
                if message["type"]=="result" || message["type"]=="error" {
                    terminal=true;
                    // Reap before notifying the UI so a follow-up run cannot race completion.
                    if let Ok(mut s)=state.lock(){if s.as_ref().map(|(i,_)|i==&id).unwrap_or(false){if let Some((_,mut c))=s.take(){let _=c.wait();}}else{break;}}
                }
                let _=app.emit("backend-message",message);
            }
        }
        if let Ok(mut s)=state.lock() {
            if s.as_ref().map(|(i,_)|i==&id).unwrap_or(false) {
                if let Some((_,mut c))=s.take(){let _=c.kill();let _=c.wait();}
                if !terminal {let _=app.emit("backend-message",json!({"protocol":1,"job_id":id,"type":"error","message":format!("Backend exited: {}",errors.lock().map(|v|v.clone()).unwrap_or_default())}));}
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn open_document(kind:String)->Result<Option<String>,String>{
    let filter=if kind=="analysis"{vec!["json"]}else if kind=="genbank"{vec!["gb","gbk"]}else{vec!["fasta","fa","fna","txt"]};
    let Some(file)=rfd::AsyncFileDialog::new().add_filter("PromoterAtlas",&filter).pick_file().await else{return Ok(None)};
    if kind=="genbank"{return Ok(Some(file.path().to_string_lossy().to_string()));}
    let max=if kind=="analysis"{20_000_000}else{250_000};
    let mut text=String::new();
    std::fs::File::open(file.path()).map_err(|e|e.to_string())?.take(max+1).read_to_string(&mut text).map_err(|e|e.to_string())?;
    if text.len() as u64>max{return Err("File too large".into());}
    Ok(Some(text))
}
#[tauri::command]
async fn save_document(name:String,extension:String,content:String)->Result<bool,String>{
    if !["json","tsv","csv","svg","gff3","gb"].contains(&extension.as_str()) || content.len()>20_000_000{return Err("Unsupported export".into());}
    let name:String=name.chars().map(|c|if c.is_alphanumeric() || c=='-' || c=='_' {c}else{'_'}).take(100).collect();
    let name=if name.is_empty(){"analysis"}else{&name};
    let filter_ext=if extension=="gb"{"gb,gbk"}else{extension.as_str()};
    let Some(file)=rfd::AsyncFileDialog::new().set_file_name(format!("{}.{}",name,extension)).add_filter(&extension,&[filter_ext]).save_file().await else{return Ok(false)};
    file.write(content.as_bytes()).await.map_err(|e|e.to_string())?;
    Ok(true)
}
#[tauri::command]
async fn save_generated_document(source_path:String,name:String,extension:String)->Result<bool,String>{
    if !["gb","gff3"].contains(&extension.as_str()){return Err("Unsupported export".into());}
    let source=std::fs::canonicalize(&source_path).map_err(|e|e.to_string())?;
    let temp_root=std::fs::canonicalize(std::env::temp_dir()).map_err(|e|e.to_string())?;
    let parent=source.parent().and_then(|p|p.file_name()).and_then(|p|p.to_str()).unwrap_or("");
    let filename=source.file_name().and_then(|p|p.to_str()).unwrap_or("");
    let expected=if extension=="gb"{filename=="annotated.gb"}else{filename=="annotated.gff3"};
    if !source.starts_with(temp_root) || !parent.starts_with("promoter-atlas-desktop-") || !expected{return Err("Invalid generated export path".into());}
    let metadata=std::fs::metadata(&source).map_err(|e|e.to_string())?;
    if !metadata.is_file() || metadata.len()>100_000_000{return Err("Generated export is too large".into());}
    let name:String=name.chars().map(|c|if c.is_alphanumeric() || c=='-' || c=='_' {c}else{'_'}).take(100).collect();
    let name=if name.is_empty(){"analysis"}else{&name};
    let Some(file)=rfd::AsyncFileDialog::new().set_file_name(format!("{}.{}",name,extension)).add_filter(&extension,&[extension.as_str()]).save_file().await else{return Ok(false)};
    std::fs::copy(source,file.path()).map_err(|e|e.to_string())?;
    Ok(true)
}
fn open_external(target:&OsStr)->Result<(),String>{
    #[cfg(target_os="macos")]
    let mut command=Command::new("/usr/bin/open");
    #[cfg(target_os="windows")]
    let mut command=Command::new("explorer.exe");
    #[cfg(all(not(target_os="macos"),not(target_os="windows")))]
    let mut command=Command::new("xdg-open");
    command.arg(target).spawn().map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
fn open_source()->Result<(),String>{
    open_external(OsStr::new("https://github.com/LucasCoppens/PromoterAtlas"))
}
#[tauri::command]
fn open_paper()->Result<(),String>{
    open_external(OsStr::new("https://www.nature.com/articles/s41467-026-72837-3"))
}
#[tauri::command]
fn open_licenses(app:tauri::AppHandle)->Result<(),String>{
    let path=app.path().resource_dir().map_err(|e|e.to_string())?.join("licenses/THIRD_PARTY_NOTICES.txt");
    open_external(path.as_os_str())
}
fn main(){
    let app=tauri::Builder::default().manage(Jobs::default()).invoke_handler(tauri::generate_handler![start_job,cancel_job,open_document,save_document,save_generated_document,open_source,open_paper,open_licenses]).build(tauri::generate_context!()).expect("Failed to build app");
    app.run(|app,event|{if matches!(event,tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested{..}){stop(&app.state::<Jobs>());}});
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn cancellation_reaps_process(){
        let jobs=Jobs::default();
        let child=if cfg!(target_os="windows") {
            Command::new("powershell.exe").args(["-NoProfile","-Command","Start-Sleep -Seconds 30"]).spawn()
        } else {
            Command::new("/bin/sleep").arg("30").spawn()
        }.unwrap();
        *jobs.0.lock().unwrap()=Some(("test".into(),child));
        stop(&jobs);
        assert!(jobs.0.lock().unwrap().is_none());
        stop(&jobs);
    }
}

import React,{useEffect,useMemo,useRef,useState} from 'react';
import {AudioLines,Mic2,Volume2,History,Heart,LogOut,Menu,X,Upload,Download,Play,Sparkles,AudioWaveform as Waveform,Trash2,Headphones,Mic,Square} from 'lucide-react';

const API=(import.meta.env.VITE_API_URL||'/api').replace(/\/$/,'');
const ABS=API.startsWith('http')?new URL(API).origin:'';
const audioSrc=(u)=>!u?'':(u.startsWith('http')?u:ABS+u);
const auth=()=>localStorage.getItem('voxora_token');
async function call(path,opts={}) {
  const headers={...(opts.headers||{})};
  if(auth()) headers.Authorization=`Bearer ${auth()}`;
  if(opts.body && !(opts.body instanceof FormData)) headers['Content-Type']='application/json';
  const r=await fetch(API+path,{...opts,headers});
  const type=r.headers.get('content-type')||'';
  const data=type.includes('application/json')?await r.json():await r.blob();
  if(!r.ok) throw new Error((data&&data.error)||`Request failed (${r.status})`);
  return data;
}
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('Could not read that file.'));reader.readAsDataURL(file);});}
const demoVoices=[
 {voice_id:'sarah',name:'Sarah',category:'free',preview_url:'/api/voices/sarah/preview',labels:{accent:'American',description:'Warm and reassuring',language:'English (US)'}},
 {voice_id:'rachel',name:'Rachel',category:'free',preview_url:'/api/voices/rachel/preview',labels:{accent:'British',description:'Calm and clear',language:'English (UK)'}},
 {voice_id:'adam',name:'Adam',category:'free',preview_url:'/api/voices/adam/preview',labels:{accent:'Australian',description:'Deep and confident',language:'English (AU)'}},
 {voice_id:'josh',name:'Josh',category:'free',preview_url:'/api/voices/josh/preview',labels:{accent:'Indian',description:'Conversational and friendly',language:'English (IN)'}},
];
export default function App(){
 const [token,setToken]=useState(auth()),[user,setUser]=useState(null),[authMode,setAuthMode]=useState('login');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState('');
 const [page,setPage]=useState('studio'),[mobile,setMobile]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [voices,setVoices]=useState(demoVoices),[voice,setVoice]=useState(demoVoices[0].voice_id),[favs,setFavs]=useState([]);
 const [text,setText]=useState('Welcome to VOXORA. Turn your words into natural, expressive speech with AI.');
 const [language,setLanguage]=useState('auto'),[speed,setSpeed]=useState(1),[stability,setStability]=useState(50),[style,setStyle]=useState(0);
 const [audio,setAudio]=useState(''),[audioEngine,setAudioEngine]=useState(''),[history,setHistory]=useState([]),[transcript,setTranscript]=useState(''),[soundPrompt,setSoundPrompt]=useState('');
 const [soundDuration,setSoundDuration]=useState(5),[engines,setEngines]=useState(null),[recording,setRecording]=useState(false),[previewAudio,setPreviewAudio]=useState('');
 const recorder=useRef(null);
 const selected=voices.find(v=>v.voice_id===voice)||voices[0];
 const words=useMemo(()=>text.trim()?text.trim().split(/\s+/).length:0,[text]);
 const speechSupported=typeof window!=='undefined'&&Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);

 useEffect(()=>{
  if(!token){setUser(null);return;}
  let alive=true;
  call('/auth/me').then(u=>{if(alive)setUser(u);}).catch(()=>{if(alive){localStorage.removeItem('voxora_token');setToken('');setUser(null);}});
  return()=>{alive=false;};
 },[token]);

 useEffect(()=>{
  if(!token)return;
  let alive=true;
  call('/voices').then(v=>{if(!alive||!Array.isArray(v)||!v.length)return;setVoices(v);setVoice(cur=>v.some(x=>x.voice_id===cur)?cur:v[0].voice_id);}).catch(e=>{if(alive)setError(e.message);});
  call('/favourites').then(f=>{if(alive)setFavs(f);}).catch(()=>{});
  call('/history').then(h=>{if(alive)setHistory(h);}).catch(e=>{if(alive)setError(e.message);});
  call('/health').then(h=>{if(alive)setEngines(h.engines);}).catch(()=>{});
  return()=>{alive=false;};
 },[token]);

 async function loadHistory(){try{setHistory(await call('/history'));}catch(e){setError(e.message);}}
 async function submitAuth(e){e.preventDefault();setBusy(true);setError('');try{const d=await call(`/auth/${authMode}`,{method:'POST',body:JSON.stringify({name,email,password})});localStorage.setItem('voxora_token',d.token);setUser(d.user);setToken(d.token);setPassword('');setNotice('Welcome to VOXORA');}catch(e){setError(e.message);}finally{setBusy(false);}}
 function logout(){localStorage.removeItem('voxora_token');setToken('');setUser(null);setAudio('');setAudioEngine('');setHistory([]);setFavs([]);setTranscript('');setPreviewAudio('');setError('');setNotice('');setPage('studio');}
 async function generate(){
  setError('');setNotice('');
  if(!text.trim())return setError('Please enter some text first.');
  setBusy(true);
  try{
   const d=await call('/tts',{method:'POST',body:JSON.stringify({text,voice_id:voice,speed,language:language==='auto'?'':language,settings:{stability:stability/100,similarity:.75,style:style/100}})});
   setAudio(audioSrc(d.audio_url));setAudioEngine(d.engine||'');setNotice(`Your speech is ready${d.engine?` · ${d.engine}`:''}`);
   loadHistory();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function toggleFav(v){
  if(!v)return;
  try{const d=await call('/favourites',{method:'POST',body:JSON.stringify({voice_id:v.voice_id,name:v.name})});setFavs(d.favourites||await call('/favourites'));setNotice(d.saved?`${v.name} saved to favourites`:`${v.name} removed from favourites`);}catch(e){setError(e.message);}
 }
 async function transcribe(file){
  if(!file)return;
  if(file.size>24*1024*1024)return setError('Audio file must be smaller than 24 MB.');
  setBusy(true);setError('');setNotice('');
  try{
   const base64=await fileToBase64(file);
   const d=await call('/transcribe',{method:'POST',body:JSON.stringify({audio_base64:base64,filename:file.name,mime:file.type||'audio/mpeg'})});
   setTranscript(d.text);setNotice('Transcription complete');loadHistory();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function saveTranscript(){
  if(!transcript.trim())return setError('There is no transcript to save yet.');
  setBusy(true);setError('');
  try{await call('/transcribe',{method:'POST',body:JSON.stringify({text:transcript,title:'Microphone transcript'})});setNotice('Transcript saved to history');loadHistory();}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 function startRecording(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return setError('Live microphone transcription needs Chrome or Edge. You can still upload an audio file.');
  setError('');setNotice('');setTranscript('');
  const rec=new SR();
  rec.lang=language==='auto'?'en-US':(language.length===2?`${language}-${language.toUpperCase()}`:'en-US');
  rec.continuous=true;rec.interimResults=true;
  let finalText='';
  rec.onresult=(event)=>{let interim='';for(let i=event.resultIndex;i<event.results.length;i+=1){const res=event.results[i];if(res.isFinal)finalText+=`${res[0].transcript} `;else interim+=res[0].transcript;}setTranscript(`${finalText}${interim}`.trim());};
  rec.onerror=(event)=>{setError(event.error==='not-allowed'?'Microphone access was blocked. Allow it in your browser and try again.':`Microphone error: ${event.error}`);setRecording(false);};
  rec.onend=()=>setRecording(false);
  recorder.current=rec;
  try{rec.start();setRecording(true);}catch(e){setError('Could not start the microphone.');}
 }
 function stopRecording(){try{recorder.current&&recorder.current.stop();}catch(e){}recorder.current=null;setRecording(false);}
 async function makeSound(){
  if(!soundPrompt.trim())return setError('Describe the sound first.');
  setBusy(true);setError('');setNotice('');
  try{
   const d=await call('/sound-effects',{method:'POST',body:JSON.stringify({prompt:soundPrompt,duration:soundDuration})});
   setAudio(audioSrc(d.audio_url));setAudioEngine(d.engine||'');setNotice(`Sound effect generated${d.engine?` · ${d.engine}`:''}`);loadHistory();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function deleteItem(id){try{await call(`/history/${id}`,{method:'DELETE'});loadHistory();}catch(e){setError(e.message);}}
 if(!token||!user)return <div className="authPage"><div className="authGlow"/><div className="authBrand"><div className="logoMark"><AudioLines/></div><span>VOXORA</span></div><div className="authCard"><div className="eyebrow">YOUR PERSONAL AI VOICE STUDIO</div><h1>{authMode==='login'?'Give your words a voice.':'Create your voice workspace.'}</h1><p className="muted">Natural voice generation, transcription and sound design — all in one place.</p><form onSubmit={submitAuth}>{authMode==='register'&&<label>Your name<input value={name} onChange={e=>setName(e.target.value)} required placeholder="Your name" autoComplete="name"/></label>}<label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email"/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} minLength="8" required placeholder="At least 8 characters" autoComplete={authMode==='login'?'current-password':'new-password'}/></label>{error&&<div className="error">{error}</div>}<button className="primary full" disabled={busy}>{busy?'Please wait…':authMode==='login'?'Sign in':'Create account'}</button></form><p className="switch">{authMode==='login'?"New to VOXORA?":"Already have an account?"} <button onClick={()=>{setAuthMode(authMode==='login'?'register':'login');setError('');}}>{authMode==='login'?'Create account':'Sign in'}</button></p><small className="muted">Your account and generated history are stored securely by the app backend.</small></div></div>;
 const nav=[['studio','Studio',Waveform],['voices','Voice library',Headphones],['transcribe','Transcribe',Mic2],['sounds','Sound effects',Volume2],['history','My history',History],['favourites','Favourites',Heart]];
 return <div className="appShell"><aside className={`sidebar ${mobile?'open':''}`}><div className="brand"><div className="logoMark"><AudioLines/></div><span>VOXORA</span><button className="mobileClose" onClick={()=>setMobile(false)}><X/></button></div><div className="sideLabel">WORKSPACE</div>{nav.map(([id,label,Icon])=><button key={id} className={`navItem ${page===id?'active':''}`} onClick={()=>{setPage(id);setMobile(false);setError('');}}><Icon size={18}/>{label}{id==='history'&&<span className="navCount">{history.length}</span>}{id==='favourites'&&favs.length>0&&<span className="navCount">{favs.length}</span>}</button>)}<div className="sideBottom"><div className="planBox"><Sparkles size={17}/><b>Your creative space</b><p>Make every word sound better.</p></div><button className="navItem" onClick={logout}><LogOut size={18}/>Sign out</button></div></aside>
 <main className="main"><header className="topbar"><button className="mobileMenu" onClick={()=>setMobile(true)}><Menu/></button><div><div className="crumb">WORKSPACE <span>/</span> {page.toUpperCase()}</div><h2>{({studio:'Voice studio',voices:'Voice library',transcribe:'Speech to text',sounds:'Sound effects',history:'Generation history',favourites:'Saved voices'})[page]}</h2></div><div className="userChip"><div className="avatar">{user.name?.[0]?.toUpperCase()}</div><span>{user.name}</span></div></header>
 {error&&<div className="alert error">{error}<button onClick={()=>setError('')}>×</button></div>}{notice&&<div className="alert success">{notice}<button onClick={()=>setNotice('')}>×</button></div>}
 {page==='studio'&&<><section className="hero"><div><div className="eyebrow"><span className="liveDot"/>{engines?.elevenlabs?'PROVIDER STUDIO CONNECTED':'FREE VOICE ENGINE ACTIVE'}</div><h1>Turn words into <em>living sound.</em></h1><p>Write your script, pick a voice and generate finished audio in seconds. Create natural, expressive voiceovers with a studio built for your ideas.</p></div><div className="heroOrb"><div className="orbCore"><AudioLines size={48}/></div><div className="orbRing ring1"/><div className="orbRing ring2"/></div></section>
 <div className="studioGrid"><section className="panel editorPanel"><div className="panelHead"><div><span className="eyebrow">01 / SCRIPT</span><h3>Your script</h3></div><button className="ghost" onClick={()=>setText('')}>Clear text</button></div><textarea className="scriptInput" maxLength="5000" value={text} onChange={e=>setText(e.target.value)} placeholder="Type or paste your text here…"/><div className="textMeta"><span>{words} words</span><span>{text.length.toLocaleString()} / 5,000 characters</span></div><div className="progress"><i style={{width:`${Math.min(100,text.length/50)}%`}}/></div><div className="controlsGrid"><label>Language<select value={language} onChange={e=>setLanguage(e.target.value)}><option value="auto">Auto detect</option><option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="it">Italian</option><option value="pt">Portuguese</option></select></label><label>Voice<select value={voice} onChange={e=>setVoice(e.target.value)}>{voices.map(v=><option key={v.voice_id} value={v.voice_id}>{v.name}</option>)}</select></label></div><div className="tuning"><div className="tuneHead"><b>Voice tuning</b><span>Fine-tune your delivery</span></div><label>Stability <span>{stability}%</span><input type="range" min="0" max="100" value={stability} onChange={e=>setStability(+e.target.value)}/></label><label>Expressiveness <span>{style}%</span><input type="range" min="0" max="100" value={style} onChange={e=>setStyle(+e.target.value)}/></label><label>Speed <span>{speed.toFixed(1)}×</span><input type="range" min="0.5" max="2" step="0.1" value={speed} onChange={e=>setSpeed(+e.target.value)}/></label></div><button className="primary generate" onClick={generate} disabled={busy}><Sparkles size={17}/>{busy?'Generating your audio…':'Generate speech'}<span>→</span></button></section>
 <section className="rightStack"><div className="panel voicePanel"><div className="panelHead"><div><span className="eyebrow">02 / VOICE</span><h3>Selected voice</h3></div><button className="textBtn" onClick={()=>setPage('voices')}>Explore all →</button></div><div className="voiceSelected"><div className="voiceAvatar">{selected?.name?.[0]||'V'}</div><div><b>{selected?.name||'Choose a voice'}</b><p>{selected?.labels?.description||selected?.category||'AI voice'}</p><small>{selected?.labels?.accent||'Multilingual'} · {selected?.labels?.language||'AI voice'}</small></div><button className={`heartBtn ${favs.some(x=>x.voice_id===voice)?'liked':''}`} onClick={()=>toggleFav(selected)}><Heart size={18} fill={favs.some(x=>x.voice_id===voice)?'currentColor':'none'}/></button></div><div className="voiceWave"><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/></div>{selected?.preview_url&&<audio className="voicePreview" controls preload="none" src={audioSrc(selected.preview_url)}/>}</div>
 <div className="panel outputPanel"><div className="panelHead"><div><span className="eyebrow">03 / OUTPUT</span><h3>Your audio</h3></div><span className="statusPill">{audio?'READY':'AWAITING AUDIO'}</span></div>{audio?<><audio controls autoPlay src={audio}/>{audioEngine&&<small className="engineTag">Generated with {audioEngine}</small>}<a className="downloadBtn" href={audio} download><Download size={16}/> Download audio</a></>:<div className="emptyAudio"><div className="emptyIcon"><Waveform/></div><b>Your voice will appear here</b><p>Write a script and generate your first audio.</p></div>}</div></section></div></>}
 {page==='voices'&&<section className="contentSection"><div className="sectionIntro"><span className="eyebrow">DISCOVER YOUR SOUND</span><h1>Find your <em>signature voice.</em></h1><p>Explore available voices from your connected voice provider. Save favourites for quick access.</p></div><div className="voiceGrid">{voices.map(v=><div className="panel voiceCard" key={v.voice_id}><div className="voiceCardTop"><div className="voiceAvatar">{v.name[0]}</div><button className={`heartBtn ${favs.some(x=>x.voice_id===v.voice_id)?'liked':''}`} onClick={()=>toggleFav(v)}><Heart fill={favs.some(x=>x.voice_id===v.voice_id)?'currentColor':'none'}/></button></div><h3>{v.name}</h3><p>{v.labels?.description||v.category||'AI voice'}</p><small>{v.labels?.language||'Voice provider'} · {v.labels?.accent||'Neutral'}</small><div className="voiceCardActions">{v.preview_url?<audio controls preload="none" src={audioSrc(v.preview_url)}/>:<span className="muted">Preview not supplied</span>}<button className="secondary" onClick={()=>{setVoice(v.voice_id);setPage('studio');}}>Use voice</button></div></div>)}</div></section>}
 {page==='transcribe'&&<section className="contentSection narrow"><div className="sectionIntro"><span className="eyebrow">AUDIO TO TEXT</span><h1>Words, <em>made readable.</em></h1><p>Record with your microphone or upload a recording and turn spoken content into editable text.</p></div><div className="panel uploadPanel"><div className="micRow"><button className={`primary ${recording?'recording':''}`} onClick={recording?stopRecording:startRecording} disabled={busy}>{recording?<Square size={16}/>:<Mic size={16}/>}{recording?'Stop recording':'Record with microphone'}</button><span className="muted">{recording?'Listening… speak now.':speechSupported?'Free in-browser transcription, no API key needed.':'Microphone transcription needs Chrome or Edge.'}</span></div><label className="uploadDrop"><Upload size={30}/><b>Choose an audio file</b><span>MP3, WAV, M4A and supported audio formats</span><input type="file" accept="audio/*" onChange={e=>{const f=e.target.files?.[0];transcribe(f);e.target.value='';}}/></label><p className="muted">{engines?.openai?'File transcripts use the connected OpenAI Whisper key on this server.':'File uploading gives a clear explanation instead of failing silently — the microphone above works with no key.'}</p>{busy&&<p>Working on your audio…</p>}{transcript&&<><h3>Your transcript</h3><textarea className="scriptInput transcript" value={transcript} onChange={e=>setTranscript(e.target.value)}/><div className="micRow"><button className="secondary" onClick={()=>navigator.clipboard.writeText(transcript)}>Copy transcript</button><button className="secondary" onClick={saveTranscript} disabled={busy}>Save to history</button></div></>}</div></section>}
 {page==='sounds'&&<section className="contentSection narrow"><div className="sectionIntro"><span className="eyebrow">GENERATIVE AUDIO</span><h1>Design a sound. <em>Set a mood.</em></h1><p>Describe the sound effect you imagine and generate an audio clip.</p></div><div className="panel soundPanel"><label>Describe your sound<textarea className="scriptInput" value={soundPrompt} onChange={e=>setSoundPrompt(e.target.value)} placeholder="Example: gentle rain falling on a window with distant thunder…"/></label><div className="tuning"><label>Length <span>{soundDuration}s</span><input type="range" min="1" max="10" value={soundDuration} onChange={e=>setSoundDuration(+e.target.value)}/></label></div><button className="primary generate" onClick={makeSound} disabled={busy}><Sparkles size={17}/>{busy?'Creating sound…':'Generate sound effect'}<span>→</span></button>{audio&&<><audio controls autoPlay src={audio}/>{audioEngine&&<small className="engineTag">Generated with {audioEngine}</small>}</>}</div></section>}
 {page==='history'&&<section className="contentSection"><div className="sectionIntro"><span className="eyebrow">YOUR CREATIVE JOURNEY</span><h1>Recently <em>created.</em></h1><p>Your latest speech, sound and transcription activity.</p></div>{previewAudio&&<div className="panel previewPanel"><div className="panelHead"><div><span className="eyebrow">NOW PLAYING</span><h3>Preview</h3></div><button className="ghost" onClick={()=>setPreviewAudio('')}>Close</button></div><audio controls autoPlay src={previewAudio}/></div>}<div className="panel historyPanel">{history.length?history.map(item=><div className="historyRow" key={item.id}><div className="historyIcon">{item.kind==='tts'?<AudioLines/>:item.kind==='sound'?<Volume2/>:<Mic2/>}</div><div className="historyInfo"><b>{item.title||item.kind}</b><span>{item.kind.toUpperCase()} · {new Date(item.created_at).toLocaleString()}{item.engine?` · ${item.engine}`:''}</span></div>{item.audio_url&&<button className="iconAction" title="Play" onClick={()=>setPreviewAudio(audioSrc(item.audio_url))}><Play/></button>}{item.audio_url&&<a className="iconAction" href={audioSrc(item.download_url||item.audio_url)} download><Download/></a>}<button className="iconAction dangerText" onClick={()=>deleteItem(item.id)}><Trash2/></button></div>):<div className="emptyAudio"><History/><b>No generations yet</b><p>Your generated content will appear here.</p></div>}</div></section>}
 {page==='favourites'&&<section className="contentSection"><div className="sectionIntro"><span className="eyebrow">YOUR SHORTLIST</span><h1>Voices you <em>love.</em></h1><p>Your saved voices, ready whenever inspiration strikes.</p></div><div className="voiceGrid">{favs.length?favs.map(v=>{const meta=voices.find(x=>x.voice_id===v.voice_id);return <div className="panel voiceCard" key={v.voice_id}><div className="voiceAvatar">{v.name[0]}</div><h3>{v.name}</h3><p>{meta?.labels?.description||'Saved voice'}</p><small>{meta?.labels?.language||'Voice library'}</small><div className="voiceCardActions"><button className="secondary" onClick={()=>{setVoice(v.voice_id);setPage('studio');}}>Use voice</button><button className="heartBtn liked" onClick={()=>toggleFav({...v,...meta})}><Heart fill="currentColor"/></button></div></div>;}):<div className="panel emptyAudio">No saved voices yet. Explore the voice library and tap the heart to save one.</div>}</div></section>}
 <footer className="footer"><span>VOXORA © 2026</span><span>MAKE EVERY WORD MATTER.</span></footer></main></div>;
}

import {useLayoutEffect,useRef,useState} from 'react';

// Animate only received content. A completed burst catches up within half a
// second; no extra requests, fabricated tokens or long typewriter backlog.
export function ResponseText({text,animate,onProgress}:{text:string;animate:boolean;onProgress:()=>void}){
  const [visible,setVisible]=useState(animate?'':text),shown=useRef(animate?'':text),target=useRef(text);
  useLayoutEffect(()=>{
    const previous=target.current;target.current=text;
    let frame=0,stopped=false;
    const paint=(value:string)=>{shown.current=value;setVisible(value);};
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
    const flush=()=>{stopped=true;cancelAnimationFrame(frame);paint(text);};
    if(!animate||motion.matches||document.hidden||text.length>100000||!text.startsWith(previous)||!text.startsWith(shown.current)){flush();return;}
    if(shown.current===text)return;
    const ends=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),v=>v.index+v.segment.length);
    let index=ends.findIndex(end=>end>shown.current.length),started=performance.now(),last=started;
    if(index<0){flush();return;}
    paint(text.slice(0,ends[index++]));
    const tick=(now:number)=>{
      if(stopped)return;
      const dt=Math.min(64,Math.max(1,now-last));last=now;
      index=Math.min(ends.length,index+Math.max(1,Math.ceil((ends.length-index)*dt/140)));
      if(now-started>=500)index=ends.length;
      paint(text.slice(0,ends[index-1]??text.length));
      if(index<ends.length)frame=requestAnimationFrame(tick);
    };
    const visibility=()=>{if(document.hidden)flush();};
    const preference=()=>{if(motion.matches)flush();};
    frame=requestAnimationFrame(tick);document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',preference);
    return()=>{stopped=true;cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',preference);};
  },[text,animate]);
  useLayoutEffect(()=>{onProgress();},[visible,onProgress]);
  return <div className="concierge-message-text" data-revealing={visible!==text?'true':undefined} aria-busy={visible!==text}>{visible}</div>;
}

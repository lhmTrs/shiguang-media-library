import React from 'react';
import {FolderKanban} from 'lucide-react';
import './project-selector.css';
type Props={projects:{id:string;name:string}[];value:string;onChange:(id:string)=>void;label:string;caption?:string;placeholder?:string;disabled?:boolean;allowEmpty?:boolean};
export function ProjectSelector({projects,value,onChange,label,caption='当前项目',placeholder='请选择项目',disabled=false,allowEmpty=true}:Props){
 const selected=projects.find(p=>p.id===value);
 return <label className="project-selector" title={label+'：'+(selected?.name||placeholder)}><FolderKanban size={16} aria-hidden="true"/><span>{caption}</span><select aria-label={label} value={selected?.id||''} disabled={disabled} onChange={e=>onChange(e.target.value)}>{(allowEmpty||!selected)&&<option value="">{placeholder}</option>}{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
}

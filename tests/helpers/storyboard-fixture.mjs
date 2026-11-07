import * as M from '../../server/storyboard/shared/model.mjs';
export function syntheticSource() {
 const p=M.emptyProject();p.title='合成分镜';p.characters=[{id:'c1',name:'陈川',age:35,role:'合成人物',description:'克制'},{id:'c2',name:'不出场人物'}];
 p.asset_manifest={character:p.characters.map(c=>({id:c.id,name:c.name})),scene:[{id:'s1',name:'合成客厅'}],prop:[{id:'p1',name:'合成包'}]};
 const s=p.scenes[0];s.location='客厅';s.scene_asset_id='s1';s.shots[0].character_ids=['c1'];s.shots[0].prop_ids=['p1'];s.shots[0].action='陈川放下包。原文不能改。';s.shots[0].camera='固定镜头';s.shots[0].dialogue=[{id:'d1',character_id:'c1',text:'合成对白。',source:'现场',performance:'平静'}];p.extensions={unknown:{keep:true}};return p;
}

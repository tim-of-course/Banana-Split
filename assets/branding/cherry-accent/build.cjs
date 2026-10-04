// Rebuild the path-only SVG masters and raster exports. No runtime dependency in the project.
// Install @resvg/resvg-js@2.6.2 and pngjs@7.0.0 in a separate tools directory,
// then run: node build.cjs --tools /path/to/tools
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const toolsArg = process.argv.indexOf('--tools');
if (toolsArg < 0 || !process.argv[toolsArg + 1]) throw new Error('Pass --tools /path/to/tools containing the renderer dependencies.');
const tools = createRequire(path.resolve(process.argv[toolsArg + 1], 'package.json'));
const { Resvg } = tools('@resvg/resvg-js');
const { PNG } = tools('pngjs');
const root = __dirname;
const g = JSON.parse(fs.readFileSync(path.join(root, 'source/geometry.json'), 'utf8'));
const p = g.palette;
const mark = (color, small=false) => `<g fill="${color}">${(small ? g.smallMarkPaths : g.markPaths).map(d=>`<path d="${d}"/>`).join('')}</g>`;
function lettering(color, cherry) {
  return `<g fill="${color}" fill-rule="evenodd">${g.letterPositions.map(([letter,x])=>{
    const glyph=g.glyphs[letter];
    let transform=`translate(${x} ${glyph.y})`;
    let d=glyph.d;
    if(glyph.mirrorOf){d=g.glyphs[glyph.mirrorOf].d;transform+=` translate(0 ${glyph.mirrorHeight}) scale(1 -1)`;}
    if(glyph.translate)transform+=` translate(${glyph.translate.join(' ')})`;
    return `<path transform="${transform}" d="${d}"/>`;
  }).join('')}</g><circle cx="${g.cherry.cx}" cy="${g.cherry.cy}" r="${g.cherry.r}" fill="${cherry}"/>`;
}
const lockup=(ink,banana=p.banana,cherry=p.cherry)=>`<g transform="translate(36 18)">${mark(banana)}</g><g transform="translate(482 144)">${lettering(ink,cherry)}</g>`;
function svg(name,width,height,body,description='Cherry Accent identity: three banana curves and a cherry-red dot over the i.') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${name}-title ${name}-desc"><title id="${name}-title">Banana Split</title><desc id="${name}-desc">${description}</desc>${body}</svg>\n`;
}
function writeSVG(name,width,height,body,description){const value=svg(name,width,height,body,description);fs.writeFileSync(path.join(root,`${name}.svg`),value);return value;}
function raster(source,name,width){const png=new Resvg(source,{fitTo:{mode:'width',value:width}}).render().asPng();fs.writeFileSync(path.join(root,name),png);return png;}
const logos={
 'logo-light':writeSVG('logo-light',1440,384,lockup(p.cocoa)),
 'logo-dark':writeSVG('logo-dark',1440,384,lockup(p.ivory)),
 'logo-black':writeSVG('logo-black',1440,384,lockup('#000000','#000000','#000000'),'Single-color black Banana Split logo.'),
 'logo-white':writeSVG('logo-white',1440,384,lockup('#FFFFFF','#FFFFFF','#FFFFFF'),'Single-color white Banana Split logo.')
};
for(const[name,source]of Object.entries(logos))raster(source,`${name}.png`,2880);
const icon=writeSVG('icon',512,512,`<g transform="translate(44 79)">${mark(p.banana)}</g>`,'Three curved banana sections. Standalone Banana Split symbol.');
writeSVG('icon-black',512,512,`<g transform="translate(44 79)">${mark('#000000')}</g>`,'Single-color Banana Split symbol.');
writeSVG('icon-white',512,512,`<g transform="translate(44 79)">${mark('#FFFFFF')}</g>`,'Single-color Banana Split symbol.');
const micro=writeSVG('icon-small',64,64,mark(p.banana,true),'Banana Split symbol with wider gaps for small sizes.');
raster(icon,'icon.png',1024);
fs.mkdirSync(path.join(root,'icons'),{recursive:true});
for(const size of [16,24,32,48,64,128,256,512])raster(size<=32?micro:icon,`icons/icon-${size}.png`,size);
const appIcon=writeSVG('app-icon',512,512,`<rect width="512" height="512" rx="108" fill="${p.charcoal}"/><g transform="translate(64 99) scale(.9)">${mark(p.banana)}</g>`,'Yellow Banana Split symbol on a charcoal rounded-square tile.');
raster(appIcon,'app-icon.png',1024);
const faviconBody=`<rect width="64" height="64" rx="14" fill="${p.charcoal}"/><g transform="translate(1.5 -1.5) scale(.96)">${mark(p.banana,true)}</g>`;
const favicon=writeSVG('favicon',64,64,faviconBody,'Banana Split favicon with a charcoal tile and wider gaps at small sizes.');
for(const size of [16,24,32,48,64])raster(favicon,`icons/favicon-${size}.png`,size);
// ICO with three PNG-compressed image entries, supported by modern browsers and desktops.
const entries=[16,32,48].map(size=>({size,data:fs.readFileSync(path.join(root,`icons/favicon-${size}.png`))}));
const header=Buffer.alloc(6+16*entries.length);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);
let offset=header.length;
entries.forEach(({size,data},i)=>{const at=6+16*i;header[at]=size;header[at+1]=size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(data.length,at+8);header.writeUInt32LE(offset,at+12);offset+=data.length;});
fs.writeFileSync(path.join(root,'favicon.ico'),Buffer.concat([header,...entries.map(e=>e.data)]));
// Ship only the square assets used by the plugin and its skill; retain the full kit here.
const pluginRoot=path.resolve(root,'../../../distribution/plugins/banana-split-v1');
const pluginAssets=path.join(pluginRoot,'assets');
const skillAssets=path.join(pluginRoot,'skills/banana-split/assets');
fs.mkdirSync(pluginAssets,{recursive:true});fs.mkdirSync(skillAssets,{recursive:true});
fs.copyFileSync(path.join(root,'favicon.svg'),path.join(pluginAssets,'composer-icon.svg'));
fs.copyFileSync(path.join(root,'app-icon.png'),path.join(pluginAssets,'icon.png'));
fs.copyFileSync(path.join(root,'favicon.svg'),path.join(skillAssets,'icon-small.svg'));
fs.copyFileSync(path.join(root,'app-icon.png'),path.join(skillAssets,'icon.png'));
// A standalone review sheet: the same geometry on light, dark, checkerboard and monochrome.
const label=(x,y,text,color=p.cocoa)=>`<text x="${x}" y="${y}" fill="${color}" font-family="DejaVu Sans,sans-serif" font-size="15" letter-spacing="2">${text}</text>`;
const proof=svg('proof',1600,1280,`<defs><pattern id="checker" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="32" height="32" fill="#E8E5DD"/><path d="M0 0H16V16H0ZM16 16H32V32H16Z" fill="#F8F6F0"/></pattern></defs><rect width="1600" height="1280" fill="${p.ivory}"/>${label(72,56,'BANANA SPLIT / CHERRY ACCENT — VECTOR MASTER')}<g transform="translate(80 84)">${lockup(p.cocoa)}</g><rect x="48" y="460" width="1504" height="384" rx="20" fill="${p.charcoal}"/><g transform="translate(80 460)">${lockup(p.ivory)}</g><rect x="48" y="880" width="790" height="248" rx="16" fill="url(#checker)"/>${label(72,918,'TRANSPARENCY / SAME VECTOR GEOMETRY')}<g transform="translate(70 940) scale(.515)">${lockup(p.cocoa)}</g>${label(902,918,'ONE COLOR')}<g transform="translate(905 944) scale(.22)">${lockup('#000000','#000000','#000000')}</g><g transform="translate(1235 937) scale(.36)">${mark('#000000')}</g>${label(72,1174,'ACTUAL PIXEL SIZES')}${[16,24,32,48,64].map((size,i)=>`<g transform="translate(${390+i*140} ${1190-(size-16)/2}) scale(${size/64})">${faviconBody}</g>${label(380+i*140,1260,String(size)+' PX')}`).join('')}`);
fs.writeFileSync(path.join(root,'proof.svg'),proof);raster(proof,'proof.png',1600);
// Verification checks alpha geometry, letter counters, palette and open symbol gaps.
const report=[];
for(const filename of ['logo-light.png','logo-dark.png','logo-black.png','logo-white.png','icon.png']){
 const png=PNG.sync.read(fs.readFileSync(path.join(root,filename)));let transparent=0,opaque=0,partial=0;
 for(let i=3;i<png.data.length;i+=4){if(png.data[i]===0)transparent++;else if(png.data[i]===255)opaque++;else partial++;}
 if(!transparent||!opaque)throw new Error(`${filename}: expected transparent background and opaque artwork`);
 for(const[x,y]of [[0,0],[png.width-1,0],[0,png.height-1],[png.width-1,png.height-1]])if(png.data[(y*png.width+x)*4+3]!==0)throw new Error(`${filename}: opaque corner`);
 report.push({file:filename,width:png.width,height:png.height,transparent,opaque,antialiased:partial});
}
// Light and dark artwork must have exactly the same alpha geometry.
const a=PNG.sync.read(fs.readFileSync(path.join(root,'logo-light.png'))),b=PNG.sync.read(fs.readFileSync(path.join(root,'logo-dark.png')));
for(let i=3;i<a.data.length;i+=4)if(a.data[i]!==b.data[i])throw new Error('Light/dark alpha mismatch');
const rgba=(png,x,y)=>[...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
for(const[x,y]of [[531,221.5],[629.5,221.5],[820.5,221.5],[1011.5,221.5],[1212,221.5]])if(rgba(a,x*2,y*2)[3]!==0)throw new Error('Filled letter counter');
if(rgba(a,2631,302).join(',')!=='201,82,70,255')throw new Error('Cherry color mismatch');
const expected=new Set(['244,197,66','48,37,34','201,82,70']);
for(let i=0;i<a.data.length;i+=4)if(a.data[i+3]===255&&!expected.has(`${a.data[i]},${a.data[i+1]},${a.data[i+2]}`))throw new Error('Unexpected opaque color');
let bands=0,previous=false;for(let y=0;y<a.height;y++){const current=rgba(a,512,y)[3]>127;if(current&&!previous)bands++;previous=current;}
if(bands!==3)throw new Error('Symbol gaps are not open');
for(const name of Object.keys(logos)){const s=fs.readFileSync(path.join(root,`${name}.svg`),'utf8');if(/<(?:text|image|script|foreignObject)\b|href=|url\(/.test(s))throw new Error(`${name}: non-portable SVG`);}
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify({renderer:'@resvg/resvg-js 2.6.2',sameLightDarkAlpha:true,transparentLetterCounters:true,openSymbolGaps:true,exactOpaquePalette:true,noExternalFontsOrImages:true,exports:report},null,2)+'\n');
console.log(JSON.stringify(report,null,2));

// Supply the same shared presentation dependency loaded by index.html to isolated VM tests.
module.exports=function(context){
  const display=require('../c4-display');
  Object.assign(context,{formatC4Score:display.score,formatC4Signed:display.signed,HSC4Display:display});
  if(context.window)context.window.HSC4Display=display;
  return context;
};

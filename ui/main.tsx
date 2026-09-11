import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import './style.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string}>{state={error:''};static getDerivedStateFromError(e:Error){return {error:e.message};}render(){return this.state.error?<main className="fatal"><h1>界面遇到错误</h1><p>{this.state.error}</p><p>任务与会话保存在本地服务中。刷新界面不会删除它们。</p><button onClick={()=>location.reload()}>重新加载界面</button></main>:this.props.children;}}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);

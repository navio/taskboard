import { createFileRoute } from '@tanstack/react-router'
import { Taskboard } from '../components/Taskboard'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return <Taskboard />
}

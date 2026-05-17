import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/staff/login');
}
